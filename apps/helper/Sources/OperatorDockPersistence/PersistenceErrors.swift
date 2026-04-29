import Foundation

public enum PersistenceSecurityError: Error, Equatable, LocalizedError {
  case keychainUnavailable
  case keyGenerationFailed
  case invalidKeyLength
  case invalidRecordFormat
  case authenticationFailed

  public var errorDescription: String? {
    switch self {
    case .keychainUnavailable:
      "Keychain material is unavailable; persistence startup fails closed."
    case .keyGenerationFailed:
      "Unable to generate secure persistence key material."
    case .invalidKeyLength:
      "Persistence key material has an invalid length."
    case .invalidRecordFormat:
      "Encrypted record has an invalid on-disk format."
    case .authenticationFailed:
      "Encrypted record authentication failed."
    }
  }
}

public enum PersistencePlatformError: Error, Equatable, LocalizedError {
  case applicationSupportUnavailable
  case migrationFailed(String)

  public var errorDescription: String? {
    switch self {
    case .applicationSupportUnavailable:
      "Unable to locate Application Support directory."
    case .migrationFailed(let reason):
      "Unable to migrate Operator Dock persistence state: \(reason)"
    }
  }
}
