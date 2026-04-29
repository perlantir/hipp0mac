import Foundation

public struct OperatorDockPaths: Sendable {
  public let root: URL
  public let eventStore: URL
  public let checkpoints: URL
  public let artifacts: URL
  public let memory: URL
  public let tasks: URL
  public let config: URL
  public let locks: URL

  public init(root: URL) throws {
    let root = root.standardizedFileURL
    self.root = root
    self.eventStore = root.appendingPathComponent("event-store", isDirectory: true)
    self.checkpoints = root.appendingPathComponent("checkpoints", isDirectory: true)
    self.artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
    self.memory = root.appendingPathComponent("memory", isDirectory: true)
    self.tasks = root.appendingPathComponent("tasks", isDirectory: true)
    self.config = root.appendingPathComponent("config", isDirectory: true)
    self.locks = root.appendingPathComponent("locks", isDirectory: true)
  }

  public func createLayout(fileManager: FileManager = .default) throws {
    for directory in [root, eventStore, checkpoints, artifacts, memory, tasks, config, locks] {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
  }

  public static func production() throws -> OperatorDockPaths {
    try OperatorDockPaths(root: defaultRoot())
  }

  private static func defaultRoot() throws -> URL {
    guard let applicationSupport = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first else {
      throw PersistencePlatformError.applicationSupportUnavailable
    }

    return applicationSupport.appendingPathComponent("OperatorDock", isDirectory: true)
  }
}
