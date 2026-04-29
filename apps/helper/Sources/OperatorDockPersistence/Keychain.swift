import Foundation
import Security

public enum PersistenceKeyAccount: String, Sendable {
  case encryptionMaster = "OperatorDock.encryption.master"
  case signingHMAC = "OperatorDock.signing.hmac"
}

public protocol KeychainClient: Sendable {
  func read(service: String, account: String) throws -> Data?
  func write(_ data: Data, service: String, account: String, accessible: String) throws
}

public struct PersistenceKeys: Sendable {
  public let encryptionKeyBytes: Data
  public let hmacKeyBytes: Data

  public init(encryptionKeyBytes: Data, hmacKeyBytes: Data) {
    self.encryptionKeyBytes = encryptionKeyBytes
    self.hmacKeyBytes = hmacKeyBytes
  }

  public func validate() throws {
    guard encryptionKeyBytes.count == 32, hmacKeyBytes.count == 32 else {
      throw PersistenceSecurityError.invalidKeyLength
    }
  }
}

public struct PersistenceKeyManager: Sendable {
  public static let service = "com.perlantir.operatordock.persistence"
  public static let requiredAccessClass = kSecAttrAccessibleAfterFirstUnlock as String

  private let keychain: KeychainClient

  public init(keychain: KeychainClient = SecurityKeychainClient()) {
    self.keychain = keychain
  }

  public func loadOrCreateKeys() throws -> PersistenceKeys {
    do {
      let encryptionKey = try keychain.read(
        service: Self.service,
        account: PersistenceKeyAccount.encryptionMaster.rawValue
      )
      let hmacKey = try keychain.read(
        service: Self.service,
        account: PersistenceKeyAccount.signingHMAC.rawValue
      )

      let resolvedEncryptionKey = try encryptionKey ?? generateAndStore(
        account: .encryptionMaster
      )
      let resolvedHMACKey = try hmacKey ?? generateAndStore(
        account: .signingHMAC
      )
      let keys = PersistenceKeys(
        encryptionKeyBytes: resolvedEncryptionKey,
        hmacKeyBytes: resolvedHMACKey
      )
      try keys.validate()
      return keys
    } catch let error as PersistenceSecurityError {
      throw error
    } catch {
      throw PersistenceSecurityError.keychainUnavailable
    }
  }

  private func generateAndStore(account: PersistenceKeyAccount) throws -> Data {
    let key = try secureRandomData(count: 32)
    do {
      try keychain.write(
        key,
        service: Self.service,
        account: account.rawValue,
        accessible: Self.requiredAccessClass
      )
      return key
    } catch {
      throw PersistenceSecurityError.keychainUnavailable
    }
  }
}

public struct SecurityKeychainClient: KeychainClient {
  public init() {}

  public func read(service: String, account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw PersistenceSecurityError.keychainUnavailable
    }

    return data
  }

  public func write(_ data: Data, service: String, account: String, accessible: String) throws {
    let identity: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
    SecItemDelete(identity as CFDictionary)

    var item = identity
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = accessible

    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
      throw PersistenceSecurityError.keychainUnavailable
    }
  }
}

public final class MockKeychainClient: KeychainClient, @unchecked Sendable {
  public var storage: [String: Data] = [:]
  public var accessClasses: [String: String] = [:]
  public var failReads = false
  public var failWrites = false

  public init() {}

  public func read(service: String, account: String) throws -> Data? {
    if failReads {
      throw PersistenceSecurityError.keychainUnavailable
    }
    return storage[key(service: service, account: account)]
  }

  public func write(_ data: Data, service: String, account: String, accessible: String) throws {
    if failWrites {
      throw PersistenceSecurityError.keychainUnavailable
    }
    storage[key(service: service, account: account)] = data
    accessClasses[account] = accessible
  }

  public func accessClass(for account: String) -> String? {
    accessClasses[account]
  }

  private func key(service: String, account: String) -> String {
    "\(service)::\(account)"
  }
}

func secureRandomData(count: Int) throws -> Data {
  var data = Data(count: count)
  let status = data.withUnsafeMutableBytes { buffer in
    SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
  }
  guard status == errSecSuccess else {
    throw PersistenceSecurityError.keyGenerationFailed
  }

  return data
}
