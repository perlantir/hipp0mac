import Foundation

public struct MigrationAuditEvent: Equatable, Sendable {
  public let recordKind: String
  public let recordId: String
  public let taskId: String?
  public let fromVersion: Int
  public let toVersion: Int

  public init(recordKind: String, recordId: String, taskId: String?, fromVersion: Int, toVersion: Int) {
    self.recordKind = recordKind
    self.recordId = recordId
    self.taskId = taskId
    self.fromVersion = fromVersion
    self.toVersion = toVersion
  }
}

public protocol MigrationAuditSink: Sendable {
  func migrationApplied(_ event: MigrationAuditEvent) throws
}

public final class RecordingMigrationAuditSink: MigrationAuditSink, @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [MigrationAuditEvent] = []

  public init() {}

  public var events: [MigrationAuditEvent] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  public func migrationApplied(_ event: MigrationAuditEvent) throws {
    lock.lock()
    storage.append(event)
    lock.unlock()
  }
}

public struct SchemaMigrationEngine: Sendable {
  public static let currentVersion = 1

  private let auditSink: MigrationAuditSink

  public init(auditSink: MigrationAuditSink) {
    self.auditSink = auditSink
  }

  public func decodeEventRecord(from data: Data) throws -> EventRecord {
    let object = try JSONObject(data)
    return try decodeEventRecord(fromJSONObject: object)
  }

  public func decodeEventRecord(fromJSONObject object: [String: Any]) throws -> EventRecord {
    let migrated = try migrateJSONObject(object, recordKind: "event")
    return try EventRecord.decode(from: canonicalJSONData(migrated))
  }

  public func migrateJSONObject(_ object: [String: Any], recordKind: String) throws -> [String: Any] {
    let version = try schemaVersion(of: object)
    if version > Self.currentVersion {
      throw EventStoreError.unknownFutureSchemaVersion(version)
    }
    if version == Self.currentVersion {
      return object
    }
    guard version == 0 else {
      throw EventStoreError.corruption(eventId: recordId(in: object), reason: "missing migration path from schemaVersion \(version)")
    }

    return try migrate_0_to_1(object, recordKind: recordKind)
  }

  private func migrate_0_to_1(_ object: [String: Any], recordKind: String) throws -> [String: Any] {
    var migrated = object
    migrated["schemaVersion"] = 1

    try auditSink.migrationApplied(
      MigrationAuditEvent(
        recordKind: recordKind,
        recordId: recordId(in: migrated) ?? "unknown",
        taskId: migrated["taskId"] as? String,
        fromVersion: 0,
        toVersion: 1
      )
    )

    return migrated
  }

  private func schemaVersion(of object: [String: Any]) throws -> Int {
    if let version = object["schemaVersion"] as? Int {
      return version
    }
    if let version = object["schemaVersion"] as? Double {
      return Int(version)
    }
    if object["schemaVersion"] == nil {
      return 0
    }
    throw EventStoreError.corruption(eventId: recordId(in: object), reason: "schemaVersion is not numeric")
  }

  private func recordId(in object: [String: Any]) -> String? {
    (object["eventId"] ?? object["taskId"] ?? object["id"]) as? String
  }
}

public func canonicalJSONData(_ object: [String: Any]) throws -> Data {
  try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
}

private func JSONObject(_ data: Data) throws -> [String: Any] {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw EventStoreError.corruption(eventId: nil, reason: "record is not a JSON object")
  }
  return object
}
