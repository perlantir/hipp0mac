import Foundation

public enum SecretLogAuditError: Error, Equatable, LocalizedError {
  case secretFound(path: String)

  public var errorDescription: String? {
    switch self {
    case .secretFound(let path):
      "Secret material was found in log file \(path)."
    }
  }
}

public struct SecretLogAuditor: Sendable {
  private let logDirectory: URL

  public init(logDirectory: URL) {
    self.logDirectory = logDirectory
  }

  public func assertNoSecrets(_ secrets: [Data]) throws {
    guard FileManager.default.fileExists(atPath: logDirectory.path) else {
      return
    }

    let files = try FileManager.default.contentsOfDirectory(
      at: logDirectory,
      includingPropertiesForKeys: [.isRegularFileKey],
      options: [.skipsHiddenFiles]
    )

    for file in files {
      let values = try file.resourceValues(forKeys: [.isRegularFileKey])
      guard values.isRegularFile == true else {
        continue
      }
      let data = try Data(contentsOf: file)
      for secret in secrets where !secret.isEmpty {
        if data.range(of: secret) != nil || data.range(of: Data(secret.hexString.utf8)) != nil {
          throw SecretLogAuditError.secretFound(path: file.path)
        }
      }
    }
  }
}
