import Foundation
import Security

public enum ProviderCredentialStoreError: LocalizedError, Equatable {
  case unableToEncodeSecret
  case keychain(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .unableToEncodeSecret:
      "Unable to encode provider credential."
    case .keychain(let status):
      "Keychain operation failed with status \(status)."
    }
  }
}

public struct ProviderCredentialStore: Sendable {
  public static let serviceName = "com.perlantir.operatordock.providers"

  public init() {}

  public func saveAPIKey(_ apiKey: String, providerId: ProviderId) throws {
    let account = Self.accountName(for: providerId)
    guard let data = apiKey.data(using: .utf8) else {
      throw ProviderCredentialStoreError.unableToEncodeSecret
    }

    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.serviceName,
      kSecAttrAccount as String: account
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

  public func deleteAPIKey(providerId: ProviderId) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.serviceName,
      kSecAttrAccount as String: Self.accountName(for: providerId)
    ]

    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw ProviderCredentialStoreError.keychain(status)
    }
  }

  public static func accountName(for providerId: ProviderId) -> String {
    "provider:\(providerId.rawValue):apiKey"
  }
}
