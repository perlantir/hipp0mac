import Foundation
import XCTest
@testable import OperatorDockPersistence

final class Phase5ACoverageTests: XCTestCase {
  func testErrorDescriptionsAreStableAndNonEmpty() {
    let errors: [LocalizedError] = [
      PersistenceSecurityError.keychainUnavailable,
      PersistenceSecurityError.keyGenerationFailed,
      PersistenceSecurityError.invalidKeyLength,
      PersistenceSecurityError.invalidRecordFormat,
      PersistenceSecurityError.authenticationFailed,
      PersistencePlatformError.applicationSupportUnavailable,
      EventStoreError.corruption(eventId: "event-1", reason: "broken chain"),
      EventStoreError.unknownFutureSchemaVersion(99),
      EventStoreError.writeFailed("disk full"),
      CheckpointStoreError.corrupt(eventId: "event-2", reason: "bad hash"),
      LockControllerError.alreadyHeld,
      LockControllerError.lockNotFound,
      LockControllerError.notOwner,
      LockControllerError.malformedLock,
      SecretLogAuditError.secretFound(path: "/tmp/helper.log")
    ]

    for error in errors {
      XCTAssertFalse((error.errorDescription ?? "").isEmpty)
    }
  }

  func testProductionPathsResolveInsideApplicationSupport() throws {
    let paths = try OperatorDockPaths.production()

    XCTAssertTrue(paths.root.path.hasSuffix("Application Support/OperatorDock/state"))
    XCTAssertEqual(paths.eventStore.lastPathComponent, "event-store")
    XCTAssertEqual(paths.checkpoints.lastPathComponent, "checkpoints")
    XCTAssertEqual(paths.locks.lastPathComponent, "locks")
  }

  func testKeyManagerLoadsExistingKeysAndRejectsInvalidLengths() throws {
    let keychain = MockKeychainClient()
    let encryption = Data(repeating: 0x01, count: 32)
    let hmac = Data(repeating: 0x02, count: 32)
    try keychain.write(
      encryption,
      service: PersistenceKeyManager.service,
      account: PersistenceKeyAccount.encryptionMaster.rawValue,
      accessible: PersistenceKeyManager.requiredAccessClass
    )
    try keychain.write(
      hmac,
      service: PersistenceKeyManager.service,
      account: PersistenceKeyAccount.signingHMAC.rawValue,
      accessible: PersistenceKeyManager.requiredAccessClass
    )

    let loaded = try PersistenceKeyManager(keychain: keychain).loadOrCreateKeys()

    XCTAssertEqual(loaded.encryptionKeyBytes, encryption)
    XCTAssertEqual(loaded.hmacKeyBytes, hmac)

    try keychain.write(
      Data(repeating: 0x03, count: 31),
      service: PersistenceKeyManager.service,
      account: PersistenceKeyAccount.encryptionMaster.rawValue,
      accessible: PersistenceKeyManager.requiredAccessClass
    )
    XCTAssertThrowsError(try PersistenceKeyManager(keychain: keychain).loadOrCreateKeys()) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .invalidKeyLength)
    }
  }

  func testKeyManagerFailsClosedWhenWritesFail() {
    let keychain = MockKeychainClient()
    keychain.failWrites = true

    XCTAssertThrowsError(try PersistenceKeyManager(keychain: keychain).loadOrCreateKeys()) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .keychainUnavailable)
    }
  }

  func testEncryptedRecordRejectsInvalidRecordFormat() throws {
    let codec = AESGCMRecordCodec(keys: fixedCoverageKeys())

    XCTAssertThrowsError(try codec.open(Data([0x01, 0x02, 0x03]))) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .invalidRecordFormat)
    }
  }

  func testJSONValueRoundTripsNestedShapes() throws {
    let expected = JSONValue.object([
      "array": .array([.boolean(true), .null, .number(4.5)]),
      "string": .string("value")
    ])

    let data = try JSONEncoder().encode(expected)
    let decoded = try JSONDecoder().decode(JSONValue.self, from: data)

    XCTAssertEqual(decoded, expected)
  }

  func testCheckpointValidationRejectsFutureSchemaAndIntegrityMismatch() throws {
    let harness = try CoverageHarness()
    let eventId = try harness.eventStore.append(taskId: "task-checkpoint-validation", eventType: "task_created", payload: [:])
    try harness.writeCheckpointRecord(
      CheckpointRecord(
        schemaVersion: 99,
        taskId: "task-checkpoint-validation",
        eventId: eventId,
        derivedState: Data("future".utf8),
        integrityHash: checkpointHash(
          schemaVersion: 99,
          taskId: "task-checkpoint-validation",
          eventId: eventId,
          derivedState: Data("future".utf8)
        )
      )
    )

    XCTAssertThrowsError(try harness.checkpoints.loadCheckpoint(taskId: "task-checkpoint-validation", eventId: eventId)) { error in
      XCTAssertEqual(error as? EventStoreError, .unknownFutureSchemaVersion(99))
    }

    try harness.writeCheckpointRecord(
      CheckpointRecord(
        taskId: "task-checkpoint-validation",
        eventId: eventId,
        derivedState: Data("mismatch".utf8),
        integrityHash: "not-the-right-hash"
      )
    )

    XCTAssertThrowsError(try harness.checkpoints.loadCheckpoint(taskId: "task-checkpoint-validation", eventId: eventId)) { error in
      XCTAssertEqual(error as? CheckpointStoreError, .corrupt(eventId: eventId, reason: "integrity hash mismatch"))
    }
  }

  func testMissingCheckpointReturnsNil() throws {
    let harness = try CoverageHarness()

    XCTAssertNil(try harness.checkpoints.loadCheckpoint(taskId: "missing", eventId: "missing-event"))
  }

  func testLockControllerRejectsMissingWrongOwnerMalformedAndFutureLocks() throws {
    let harness = try CoverageHarness()

    XCTAssertThrowsError(try harness.lockController.heartbeat(LockHandle(taskId: "missing-lock", daemonInstanceId: "daemon-coverage"))) { error in
      XCTAssertEqual(error as? LockControllerError, .lockNotFound)
    }

    let handle = try harness.lockController.acquire(taskId: "task-lock-errors")
    let wrongOwner = LockHandle(taskId: handle.taskId, daemonInstanceId: "other-daemon")
    XCTAssertThrowsError(try harness.lockController.heartbeat(wrongOwner)) { error in
      XCTAssertEqual(error as? LockControllerError, .notOwner)
    }
    XCTAssertThrowsError(try harness.lockController.release(wrongOwner)) { error in
      XCTAssertEqual(error as? LockControllerError, .notOwner)
    }

    try Data("not-json".utf8).write(to: harness.lockURL(taskId: "task-malformed-lock"))
    XCTAssertThrowsError(try harness.lockController.readLock(taskId: "task-malformed-lock")) { error in
      XCTAssertEqual(error as? LockControllerError, .malformedLock)
    }

    let future = TaskLockRecord(
      schemaVersion: 99,
      daemonInstanceId: "future-daemon",
      pid: 707,
      acquiredAt: iso8601Milliseconds(),
      lastHeartbeat: iso8601Milliseconds()
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(future).write(to: harness.lockURL(taskId: "task-future-lock"))
    XCTAssertThrowsError(try harness.lockController.readLock(taskId: "task-future-lock")) { error in
      XCTAssertEqual(error as? EventStoreError, .unknownFutureSchemaVersion(99))
    }
  }

  func testMalformedHeartbeatIsTreatedAsStaleAndReclaimed() throws {
    let harness = try CoverageHarness()
    let malformedHeartbeat = TaskLockRecord(
      daemonInstanceId: "old-daemon",
      pid: 808,
      acquiredAt: "not-a-date",
      lastHeartbeat: "not-a-date"
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(malformedHeartbeat).write(to: harness.lockURL(taskId: "task-malformed-heartbeat"))

    let handle = try harness.lockController.acquire(taskId: "task-malformed-heartbeat")

    XCTAssertEqual(handle.daemonInstanceId, "daemon-coverage")
    XCTAssertTrue(try harness.eventStore.readAll(taskId: "task-malformed-heartbeat").contains { $0.eventType == "lock_reclaimed" })
  }

  func testSecretLogAuditorDetectsRawAndHexSecretsAndIgnoresMissingDirectory() throws {
    let missing = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-missing-logs-\(UUID().uuidString)", isDirectory: true)
    try SecretLogAuditor(logDirectory: missing).assertNoSecrets([Data("secret".utf8)])

    let logs = try temporaryDirectory()
    try FileManager.default.createDirectory(at: logs.appendingPathComponent("nested", isDirectory: true), withIntermediateDirectories: true)
    let rawSecret = Data("raw-secret".utf8)
    let hexSecret = Data("hex-secret".utf8)

    try Data("prefix raw-secret suffix".utf8).write(to: logs.appendingPathComponent("raw.log"))
    XCTAssertThrowsError(try SecretLogAuditor(logDirectory: logs).assertNoSecrets([rawSecret])) { error in
      XCTAssertTrue((error as? SecretLogAuditError)?.errorDescription?.contains("raw.log") == true)
    }

    try FileManager.default.removeItem(at: logs.appendingPathComponent("raw.log"))
    try Data(hexSecret.hexString.utf8).write(to: logs.appendingPathComponent("hex.log"))
    XCTAssertThrowsError(try SecretLogAuditor(logDirectory: logs).assertNoSecrets([hexSecret])) { error in
      XCTAssertTrue((error as? SecretLogAuditError)?.errorDescription?.contains("hex.log") == true)
    }
  }

  private func fixedCoverageKeys() -> PersistenceKeys {
    PersistenceKeys(
      encryptionKeyBytes: Data(repeating: 0x91, count: 32),
      hmacKeyBytes: Data(repeating: 0x92, count: 32)
    )
  }
}

private final class CoverageHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x71, count: 32),
    hmacKeyBytes: Data(repeating: 0x72, count: 32)
  )
  let eventStore: EventStore
  let checkpoints: CheckpointStore
  let clock = TestClock(start: Date(timeIntervalSince1970: 1_777_200_000))
  let lockController: LockController

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-coverage-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    checkpoints = CheckpointStore(paths: paths, keys: keys, eventStore: eventStore)
    lockController = LockController(paths: paths, eventStore: eventStore, clock: clock, daemonInstanceId: "daemon-coverage", pid: 707)
  }

  func writeCheckpointRecord(_ record: CheckpointRecord) throws {
    let url = paths.checkpoints
      .appendingPathComponent(record.taskId, isDirectory: true)
      .appendingPathComponent("\(record.eventId).checkpoint")
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let encrypted = try AESGCMRecordCodec(keys: keys).seal(record.encoded()).bytes
    try encrypted.write(to: url, options: .atomic)
  }

  func lockURL(taskId: String) -> URL {
    paths.locks.appendingPathComponent("\(taskId).lock")
  }
}
