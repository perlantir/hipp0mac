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
