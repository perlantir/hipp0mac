import CryptoKit
import Foundation

public struct SealedPersistenceRecord: Sendable {
  public let bytes: Data
  public let nonce: Data
}

public struct AESGCMRecordCodec: Sendable {
  private let keys: PersistenceKeys
  private let nonceGenerator: @Sendable () throws -> Data

  public init(
    keys: PersistenceKeys,
    nonceGenerator: @escaping @Sendable () throws -> Data = AESGCMRecordCodec.randomNonce
  ) {
    self.keys = keys
    self.nonceGenerator = nonceGenerator
  }

  public static func randomNonce() throws -> Data {
    try secureRandomData(count: 12)
  }

  public func seal(_ plaintext: Data) throws -> SealedPersistenceRecord {
    try keys.validate()
    let nonceBytes = try nonceGenerator()
    guard nonceBytes.count == 12 else {
      throw PersistenceSecurityError.invalidRecordFormat
    }

    let nonce = try AES.GCM.Nonce(data: nonceBytes)
    let sealed = try AES.GCM.seal(
      plaintext,
      using: SymmetricKey(data: keys.encryptionKeyBytes),
      nonce: nonce
    )
    let body = nonceBytes + sealed.ciphertext + sealed.tag
    let bytes = encodeLength(body.count) + body
    return SealedPersistenceRecord(bytes: bytes, nonce: nonceBytes)
  }

  public func open(_ recordBytes: Data) throws -> Data {
    try keys.validate()
    guard recordBytes.count >= 4 else {
      throw PersistenceSecurityError.invalidRecordFormat
    }

    let declaredLength = Int(decodeLength(recordBytes.prefix(4)))
    guard declaredLength == recordBytes.count - 4 else {
      throw PersistenceSecurityError.invalidRecordFormat
    }
    guard declaredLength >= 28 else {
      throw PersistenceSecurityError.invalidRecordFormat
    }

    let body = recordBytes.dropFirst(4)
    let nonceBytes = Data(body.prefix(12))
    let ciphertextWithTag = body.dropFirst(12)
    let ciphertext = Data(ciphertextWithTag.dropLast(16))
    let tag = Data(ciphertextWithTag.suffix(16))

    do {
      let sealed = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceBytes),
        ciphertext: ciphertext,
        tag: tag
      )
      return try AES.GCM.open(sealed, using: SymmetricKey(data: keys.encryptionKeyBytes))
    } catch {
      throw PersistenceSecurityError.authenticationFailed
    }
  }
}

func encodeLength(_ length: Int) -> Data {
  var value = UInt32(length).bigEndian
  return Data(bytes: &value, count: MemoryLayout<UInt32>.size)
}

func decodeLength(_ bytes: Data.SubSequence) -> UInt32 {
  bytes.reduce(UInt32(0)) { partial, byte in
    (partial << 8) | UInt32(byte)
  }
}
