import Foundation
import Security

public enum PlatformEvent {
  public static let taskId = "platform"
}

public struct XPCConnectionRequest: Equatable, Sendable {
  public let clientIdentifier: String
  public let auditToken: Data

  public init(clientIdentifier: String, auditToken: Data) {
    self.clientIdentifier = clientIdentifier
    self.auditToken = auditToken
  }
}

public enum CodeValidationResult: Equatable, Sendable {
  case accepted(teamIdentifier: String?, entitlements: [String])
  case rejected(reason: String)
}

public protocol ClientCodeValidator: Sendable {
  func validate(_ request: XPCConnectionRequest) -> CodeValidationResult
}

public struct MockClientCodeValidator: ClientCodeValidator {
  private let result: CodeValidationResult

  public init(result: CodeValidationResult) {
    self.result = result
  }

  public func validate(_ request: XPCConnectionRequest) -> CodeValidationResult {
    result
  }
}

public struct SecCodeClientValidator: ClientCodeValidator {
  private let requiredEntitlements: Set<String>

  public init(requiredEntitlements: Set<String> = ["com.perlantir.operatordock.client"]) {
    self.requiredEntitlements = requiredEntitlements
  }

  public func validate(_ request: XPCConnectionRequest) -> CodeValidationResult {
    let attributes: [String: Any] = [
      kSecGuestAttributeAudit as String: request.auditToken
    ]
    var maybeCode: SecCode?
    let guestStatus = SecCodeCopyGuestWithAttributes(
      nil,
      attributes as CFDictionary,
      SecCSFlags(),
      &maybeCode
    )
    guard guestStatus == errSecSuccess, let code = maybeCode else {
      return .rejected(reason: "SecCodeCopyGuestWithAttributes failed with status \(guestStatus)")
    }

    let validity = SecCodeCheckValidity(code, SecCSFlags(), nil)
    guard validity == errSecSuccess else {
      return .rejected(reason: "SecCodeCheckValidity failed with status \(validity)")
    }

    var maybeStaticCode: SecStaticCode?
    let staticStatus = SecCodeCopyStaticCode(code, SecCSFlags(), &maybeStaticCode)
    guard staticStatus == errSecSuccess, let staticCode = maybeStaticCode else {
      return .rejected(reason: "SecCodeCopyStaticCode failed with status \(staticStatus)")
    }

    var maybeInfo: CFDictionary?
    let infoStatus = SecCodeCopySigningInformation(
      staticCode,
      SecCSFlags(rawValue: kSecCSSigningInformation),
      &maybeInfo
    )
    guard infoStatus == errSecSuccess, let info = maybeInfo as? [String: Any] else {
      return .rejected(reason: "SecCodeCopySigningInformation failed with status \(infoStatus)")
    }

    let entitlementDictionary = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    let presentEntitlements = Set(entitlementDictionary.compactMap { key, value -> String? in
      guard (value as? Bool) == true else {
        return nil
      }
      return key
    })
    let missing = requiredEntitlements.subtracting(presentEntitlements)
    guard missing.isEmpty else {
      return .rejected(reason: "Missing required entitlements: \(missing.sorted().joined(separator: ","))")
    }

    let teamIdentifier = info[kSecCodeInfoTeamIdentifier as String] as? String
    return .accepted(teamIdentifier: teamIdentifier, entitlements: presentEntitlements.sorted())
  }
}

public struct XPCSecurityGate: Sendable {
  private let eventStore: EventStore
  private let validator: ClientCodeValidator

  public init(eventStore: EventStore, validator: ClientCodeValidator = SecCodeClientValidator()) {
    self.eventStore = eventStore
    self.validator = validator
  }

  public func establishConnection(_ request: XPCConnectionRequest) throws -> CodeValidationResult {
    let result = validator.validate(request)

    switch result {
    case .accepted(let teamIdentifier, let entitlements):
      try eventStore.append(
        taskId: PlatformEvent.taskId,
        eventType: "xpc_connection_accepted",
        payload: [
          "clientIdentifier": .string(request.clientIdentifier),
          "teamIdentifier": teamIdentifier.map(JSONValue.string) ?? .null,
          "entitlements": .array(entitlements.map(JSONValue.string))
        ]
      )
    case .rejected(let reason):
      try eventStore.append(
        taskId: PlatformEvent.taskId,
        eventType: "xpc_connection_rejected",
        payload: [
          "clientIdentifier": .string(request.clientIdentifier),
          "reason": .string(reason)
        ]
      )
    }

    return result
  }
}
