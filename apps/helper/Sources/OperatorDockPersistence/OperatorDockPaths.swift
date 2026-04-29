import Foundation

public struct OperatorDockPaths: Sendable {
  public static let migrationMarkerFilename = ".migrated-from-v0"

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
    guard let applicationSupport = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first else {
      throw PersistencePlatformError.applicationSupportUnavailable
    }

    return try production(applicationSupportDirectory: applicationSupport)
  }

  public static func production(applicationSupportDirectory: URL, fileManager: FileManager = .default) throws -> OperatorDockPaths {
    let operatorDockRoot = applicationSupportDirectory
      .appendingPathComponent("OperatorDock", isDirectory: true)
      .standardizedFileURL
    let stateRoot = operatorDockRoot.appendingPathComponent("state", isDirectory: true)
    try migrateLegacyStateIfNeeded(
      legacyRoot: operatorDockRoot,
      stateRoot: stateRoot,
      fileManager: fileManager
    )
    return try OperatorDockPaths(root: stateRoot)
  }

  private static func migrateLegacyStateIfNeeded(
    legacyRoot: URL,
    stateRoot: URL,
    fileManager: FileManager
  ) throws {
    let marker = stateRoot.appendingPathComponent(migrationMarkerFilename)
    if fileManager.fileExists(atPath: marker.path) {
      return
    }

    let legacyDirectories = [
      "event-store",
      "checkpoints",
      "artifacts",
      "memory",
      "tasks",
      "config",
      "locks"
    ]
    let existingLegacyDirectories = legacyDirectories.filter { name in
      var isDirectory: ObjCBool = false
      let url = legacyRoot.appendingPathComponent(name, isDirectory: true)
      return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    try fileManager.createDirectory(at: stateRoot, withIntermediateDirectories: true)
    guard !existingLegacyDirectories.isEmpty else {
      return
    }

    for name in existingLegacyDirectories {
      let source = legacyRoot.appendingPathComponent(name, isDirectory: true)
      let destination = stateRoot.appendingPathComponent(name, isDirectory: true)
      if fileManager.fileExists(atPath: destination.path) {
        throw PersistencePlatformError.migrationFailed("destination already exists for \(name)")
      }
      try fileManager.moveItem(at: source, to: destination)
      guard fileManager.fileExists(atPath: destination.path),
            !fileManager.fileExists(atPath: source.path) else {
        throw PersistencePlatformError.migrationFailed("verification failed for \(name)")
      }
    }

    let markerPayload = LegacyMigrationMarker(
      schemaVersion: 1,
      migratedAt: iso8601Milliseconds(),
      from: legacyRoot.path,
      movedEntries: existingLegacyDirectories.sorted()
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(markerPayload).write(to: marker, options: .atomic)
  }
}

private struct LegacyMigrationMarker: Codable {
  let schemaVersion: Int
  let migratedAt: String
  let from: String
  let movedEntries: [String]
}
