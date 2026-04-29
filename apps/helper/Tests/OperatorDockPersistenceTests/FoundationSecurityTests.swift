import CryptoKit
import Foundation
import XCTest
@testable import OperatorDockPersistence

final class FoundationSecurityTests: XCTestCase {
  func testFilesystemLayoutCreatesRequiredDirectories() throws {
    let paths = try OperatorDockPaths(root: temporaryDirectory())

    try paths.createLayout()

    for directory in [
      paths.eventStore,
      paths.checkpoints,
      paths.artifacts,
      paths.memory,
      paths.tasks,
      paths.config,
      paths.locks
    ] {
      var isDirectory: ObjCBool = false
      XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory))
      XCTAssertTrue(isDirectory.boolValue, "\(directory.path) should be a directory")
    }
  }

  func testProductionLayoutMigratesLegacyV0ApplicationSupportState() throws {
    let applicationSupport = try temporaryDirectory()
    let legacyRoot = applicationSupport.appendingPathComponent("OperatorDock", isDirectory: true)
    let legacyEventStore = legacyRoot.appendingPathComponent("event-store", isDirectory: true)
    let legacyTasks = legacyRoot.appendingPathComponent("tasks", isDirectory: true)
    try FileManager.default.createDirectory(at: legacyEventStore, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: legacyTasks, withIntermediateDirectories: true)
    try Data("legacy-event".utf8).write(to: legacyEventStore.appendingPathComponent("task-1.log"))
    try Data("legacy-task".utf8).write(to: legacyTasks.appendingPathComponent("task-1.json"))

    let paths = try OperatorDockPaths.production(applicationSupportDirectory: applicationSupport)

    XCTAssertEqual(paths.root, legacyRoot.appendingPathComponent("state", isDirectory: true).standardizedFileURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.eventStore.appendingPathComponent("task-1.log").path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.tasks.appendingPathComponent("task-1.json").path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.root.appendingPathComponent(OperatorDockPaths.migrationMarkerFilename).path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: legacyEventStore.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: legacyTasks.path))
  }

  func testProductionLayoutMarkerPreventsRepeatedMigration() throws {
    let applicationSupport = try temporaryDirectory()
    let operatorDockRoot = applicationSupport.appendingPathComponent("OperatorDock", isDirectory: true)
    let stateRoot = operatorDockRoot.appendingPathComponent("state", isDirectory: true)
    try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
    try Data("already migrated".utf8).write(to: stateRoot.appendingPathComponent(OperatorDockPaths.migrationMarkerFilename))

    let paths = try OperatorDockPaths.production(applicationSupportDirectory: applicationSupport)

    XCTAssertEqual(paths.root, stateRoot.standardizedFileURL)
  }

  func testProductionLayoutMigrationFailsWhenDestinationExists() throws {
    let applicationSupport = try temporaryDirectory()
    let legacyRoot = applicationSupport.appendingPathComponent("OperatorDock", isDirectory: true)
    try FileManager.default.createDirectory(at: legacyRoot.appendingPathComponent("event-store", isDirectory: true), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: legacyRoot
        .appendingPathComponent("state", isDirectory: true)
        .appendingPathComponent("event-store", isDirectory: true),
      withIntermediateDirectories: true
    )

    XCTAssertThrowsError(try OperatorDockPaths.production(applicationSupportDirectory: applicationSupport)) { error in
      XCTAssertTrue((error as? PersistencePlatformError)?.errorDescription?.contains("destination already exists") == true)
    }
  }

  func testKeychainKeysGeneratedOnFirstLaunchWithRequiredAccessClass() throws {
    let keychain = MockKeychainClient()
    let manager = PersistenceKeyManager(keychain: keychain)

    let keys = try manager.loadOrCreateKeys()

    XCTAssertEqual(keys.encryptionKeyBytes.count, 32)
    XCTAssertEqual(keys.hmacKeyBytes.count, 32)
    XCTAssertEqual(
      keychain.accessClass(for: PersistenceKeyAccount.encryptionMaster.rawValue),
      PersistenceKeyManager.requiredAccessClass
    )
    XCTAssertEqual(
      keychain.accessClass(for: PersistenceKeyAccount.signingHMAC.rawValue),
      PersistenceKeyManager.requiredAccessClass
    )
  }

  func testMissingKeyFailsClosedWhenKeychainUnavailable() {
    let keychain = MockKeychainClient()
    keychain.failReads = true
    let manager = PersistenceKeyManager(keychain: keychain)

    XCTAssertThrowsError(try manager.loadOrCreateKeys()) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .keychainUnavailable)
    }
    XCTAssertTrue(keychain.storage.isEmpty)
  }

  func testCiphertextUnreadableWithoutKey() throws {
    let keys = fixedKeys()
    let codec = AESGCMRecordCodec(keys: keys)
    let plaintext = Data(#"{"payload":{"secret":"enterprise-value"}}"#.utf8)

    let sealed = try codec.seal(plaintext)

    XCTAssertFalse(String(decoding: sealed.bytes, as: UTF8.self).contains("enterprise-value"))
    XCTAssertEqual(try codec.open(sealed.bytes), plaintext)
  }

  func testNonceUniquenessAcrossManyRecords() throws {
    let codec = AESGCMRecordCodec(keys: fixedKeys())
    var nonces = Set<Data>()

    for index in 0..<10_000 {
      let sealed = try codec.seal(Data("record-\(index)".utf8))
      XCTAssertTrue(nonces.insert(sealed.nonce).inserted)
    }
  }

  func testGCMTagTamperDetection() throws {
    let codec = AESGCMRecordCodec(keys: fixedKeys())
    var sealed = try codec.seal(Data("authentic".utf8)).bytes

    sealed[sealed.count - 1] ^= 0x01

    XCTAssertThrowsError(try codec.open(sealed)) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .authenticationFailed)
    }
  }

  private func fixedKeys() -> PersistenceKeys {
    PersistenceKeys(
      encryptionKeyBytes: Data(repeating: 0xA1, count: 32),
      hmacKeyBytes: Data(repeating: 0xB2, count: 32)
    )
  }
}

extension XCTestCase {
  func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock {
      try? FileManager.default.removeItem(at: url)
    }
    return url
  }
}
