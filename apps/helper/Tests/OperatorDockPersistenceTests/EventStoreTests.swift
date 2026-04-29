import Foundation
import XCTest
@testable import OperatorDockPersistence

final class EventStoreTests: XCTestCase {
  func testAppendThenReadPreservesOrderAndPayloads() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    let taskId = "task-append-read"

    for index in 0..<25 {
      _ = try store.append(
        taskId: taskId,
        eventType: "task_created",
        payload: ["index": .number(Double(index))]
      )
    }

    let events = try store.readAll(taskId: taskId)
    XCTAssertEqual(events.map(\.payload), (0..<25).map { ["index": .number(Double($0))] })
    XCTAssertEqual(events.map(\.parentEventId), [nil] + events.dropLast().map(\.eventId))
  }

  func testHashChainIntegrityAcrossOneHundredEvents() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()

    for index in 0..<100 {
      _ = try store.append(
        taskId: "task-chain",
        eventType: "task_state_transition",
        payload: ["step": .number(Double(index))]
      )
    }

    XCTAssertNoThrow(try store.verify(taskId: "task-chain"))
  }

  func testHMACTamperDetectionPointsAtCorrectEventId() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    let first = try store.append(taskId: "task-hmac", eventType: "task_created", payload: ["name": .string("first")])
    let second = try store.append(taskId: "task-hmac", eventType: "task_state_transition", payload: ["name": .string("second")])

    try harness.tamperPlaintextRecord(taskId: "task-hmac", eventId: second) { record in
      record.payload = ["name": .string("tampered")]
    }

    XCTAssertThrowsError(try store.verify(taskId: "task-hmac")) { error in
      guard case let EventStoreError.corruption(eventId, reason) = error else {
        return XCTFail("Expected corruption, got \(error)")
      }
      XCTAssertEqual(eventId, second)
      XCTAssertTrue(reason.contains("hmac"))
      XCTAssertNotEqual(eventId, first)
    }
  }

  func testSchemaVersionRecordedOnEveryEvent() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()

    for index in 0..<10 {
      _ = try store.append(
        taskId: "task-schema",
        eventType: "task_created",
        payload: ["index": .number(Double(index))]
      )
    }

    XCTAssertTrue(try store.readAll(taskId: "task-schema").allSatisfy { $0.schemaVersion == 1 })
  }

  func testMonotonicUUIDV7EventIds() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()

    let ids = try (0..<200).map { index in
      try store.append(
        taskId: "task-monotonic",
        eventType: "task_created",
        payload: ["index": .number(Double(index))]
      )
    }

    XCTAssertEqual(ids, ids.sorted())
    XCTAssertTrue(ids.allSatisfy(UUIDV7.isValid(_:)))
  }

  func testCrashMidAppendNoPartialRecord() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    let taskId = "task-torn"
    _ = try store.append(taskId: taskId, eventType: "task_created", payload: ["ok": .boolean(true)])

    try harness.writePartialEncryptedRecord(taskId: taskId, plaintext: Data(#"{"not":"complete"}"#.utf8))

    let restarted = try harness.store()
    XCTAssertEqual(try restarted.readAll(taskId: taskId).count, 1)
    XCTAssertNoThrow(try restarted.verify(taskId: taskId))
  }

  func testFsyncBeforeAck() throws {
    let harness = try EventStoreHarness()
    let recorder = FsyncRecorder()
    let store = try harness.store(fsyncRecorder: recorder)

    let eventId = try store.append(
      taskId: "task-fsync",
      eventType: "task_created",
      payload: ["acked": .boolean(true)]
    )

    XCTAssertEqual(recorder.calls, [.fsyncStarted, .fsyncCompleted, .appendReturned(eventId)])
  }

  func testPowerLossSimulationTruncatesCleanly() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    let taskId = "task-power-loss"
    for index in 0..<3 {
      _ = try store.append(taskId: taskId, eventType: "task_created", payload: ["index": .number(Double(index))])
    }

    try harness.dropLastWriteBytes(taskId: taskId, byteCount: 9)

    XCTAssertEqual(try store.readAll(taskId: taskId).count, 2)
    XCTAssertNoThrow(try store.verify(taskId: taskId))
  }

  func testConcurrentAppendsSerialized() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    let group = DispatchGroup()
    let queue = DispatchQueue(label: "event-store.concurrent", attributes: .concurrent)
    let errors = ThreadSafeErrorBag()

    for thread in 0..<10 {
      group.enter()
      queue.async {
        defer { group.leave() }
        do {
          for index in 0..<20 {
            _ = try store.append(
              taskId: "task-concurrent",
              eventType: "task_created",
              payload: ["thread": .number(Double(thread)), "index": .number(Double(index))]
            )
          }
        } catch {
          errors.append(error)
        }
      }
    }

    group.wait()

    XCTAssertTrue(errors.all.isEmpty, "\(errors.all)")
    XCTAssertEqual(try store.readAll(taskId: "task-concurrent").count, 200)
    XCTAssertNoThrow(try store.verify(taskId: "task-concurrent"))
  }

  func testEventStoreCiphertextContainsNoPlaintextPayloadFields() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()

    _ = try store.append(
      taskId: "task-encrypted",
      eventType: "task_created",
      payload: ["secretField": .string("payload-secret")]
    )

    let raw = try Data(contentsOf: harness.paths.eventStore.appendingPathComponent("task-encrypted.log"))
    let rawText = String(decoding: raw, as: UTF8.self)
    XCTAssertFalse(rawText.contains("secretField"))
    XCTAssertFalse(rawText.contains("payload-secret"))
  }

  func testEventStoreGCMTagTamperDetection() throws {
    let harness = try EventStoreHarness()
    let store = try harness.store()
    _ = try store.append(taskId: "task-gcm", eventType: "task_created", payload: ["ok": .boolean(true)])

    try harness.flipLastByte(taskId: "task-gcm")

    XCTAssertThrowsError(try store.readAll(taskId: "task-gcm")) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .authenticationFailed)
    }
  }
}

private final class ThreadSafeErrorBag: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [Error] = []

  var all: [Error] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ error: Error) {
    lock.lock()
    storage.append(error)
    lock.unlock()
  }
}

private final class EventStoreHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x11, count: 32),
    hmacKeyBytes: Data(repeating: 0x22, count: 32)
  )

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-event-store-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
  }

  func store(fsyncRecorder: FsyncRecorder = FsyncRecorder()) throws -> EventStore {
    EventStore(paths: paths, keys: keys, fsyncRecorder: fsyncRecorder)
  }

  func tamperPlaintextRecord(
    taskId: String,
    eventId: String,
    mutate: (inout EventRecord) -> Void
  ) throws {
    let codec = AESGCMRecordCodec(keys: keys)
    let url = paths.eventStore.appendingPathComponent("\(taskId).log")
    let records = try EncryptedRecordFile.readRecords(from: url, codec: codec).records
    let rewritten = try records.map { raw -> Data in
      var event = try EventRecord.decode(from: codec.open(raw.bytes))
      if event.eventId == eventId {
        mutate(&event)
        return try codec.seal(event.encoded()).bytes
      }
      return raw.bytes
    }
    try rewritten.reduce(into: Data()) { $0.append($1) }.write(to: url, options: .atomic)
  }

  func writePartialEncryptedRecord(taskId: String, plaintext: Data) throws {
    let codec = AESGCMRecordCodec(keys: keys)
    let sealed = try codec.seal(plaintext).bytes
    let partial = sealed.prefix(max(1, sealed.count / 2))
    let url = paths.eventStore.appendingPathComponent("\(taskId).log")
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data(partial))
    try handle.close()
  }

  func dropLastWriteBytes(taskId: String, byteCount: Int) throws {
    let url = paths.eventStore.appendingPathComponent("\(taskId).log")
    let data = try Data(contentsOf: url)
    try data.dropLast(byteCount).write(to: url, options: .atomic)
  }

  func flipLastByte(taskId: String) throws {
    let url = paths.eventStore.appendingPathComponent("\(taskId).log")
    var data = try Data(contentsOf: url)
    data[data.count - 1] ^= 0x01
    try data.write(to: url, options: .atomic)
  }
}
