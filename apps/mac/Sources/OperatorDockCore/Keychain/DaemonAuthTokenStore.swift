import Foundation
import Security

public struct DaemonAuthTokenStore: Sendable {
  public static let serviceName = "com.perlantir.operatordock.daemon"
  public static let accountName = "daemon:httpBearerToken"

  public init() {}

  public func readToken() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.serviceName,
      kSecAttrAccount as String: Self.accountName,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess,
          let data = result as? Data,
          let token = String(data: data, encoding: .utf8),
          !token.isEmpty else {
      return nil
    }

    return token
  }
}
