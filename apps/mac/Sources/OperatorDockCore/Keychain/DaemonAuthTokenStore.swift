import Foundation
import Security

public struct DaemonAuthTokenStore: Sendable {
  public static let serviceName = "com.perlantir.operatordock.daemon"
  public static let accountName = "daemon:httpBearerToken"

  public init() {}

  public func loadOrCreateToken() throws -> String {
    if let existing = try loadToken() {
      return existing
    }

    let token = try generateToken()
    try saveToken(token)
    return token
  }

  public func loadToken() throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.serviceName,
      kSecAttrAccount as String: Self.accountName,
      kSecReturnData as String: true
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw ProviderCredentialStoreError.keychain(status)
    }

    guard let data = result as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  public func loadTokenIgnoringErrors() -> String? {
    try? loadToken()
  }

  public func loadOrCreateTokenIgnoringErrors() -> String? {
    try? loadOrCreateToken()
  }

  private func saveToken(_ token: String) throws {
    guard let data = token.data(using: .utf8) else {
      throw ProviderCredentialStoreError.unableToEncodeSecret
    }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.serviceName,
      kSecAttrAccount as String: Self.accountName
    ]

    SecItemDelete(query as CFDictionary)

    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw ProviderCredentialStoreError.keychain(status)
    }
  }

  private func generateToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw ProviderCredentialStoreError.keychain(status)
    }

    return Data(bytes).base64EncodedString()
  }
}
