import Foundation
import XCTest
@testable import OperatorDockPersistence

final class SchemaMigrationTests: XCTestCase {
  func testV0ToV1MigrationFixtureLoadsAndEmitsAuditEvent() throws {
    let audit = RecordingMigrationAuditSink()
    let engine = SchemaMigrationEngine(auditSink: audit)

    let migrated = try engine.decodeEventRecord(from: Self.v0EventFixture)

    XCTAssertEqual(migrated.schemaVersion, 1)
    XCTAssertEqual(migrated.eventId, "018f2b9c-7c00-7000-8000-000000000001")
    XCTAssertEqual(migrated.payload, ["legacy": .boolean(true)])
    XCTAssertEqual(audit.events, [
      MigrationAuditEvent(
        recordKind: "event",
        recordId: migrated.eventId,
        taskId: migrated.taskId,
        fromVersion: 0,
        toVersion: 1
      )
    ])
  }

  func testUnknownFutureVersionHardErrors() throws {
    let engine = SchemaMigrationEngine(auditSink: RecordingMigrationAuditSink())
    var object = try Self.v1EventObject()
    object["schemaVersion"] = 99

    XCTAssertThrowsError(try engine.decodeEventRecord(fromJSONObject: object)) { error in
      XCTAssertEqual(error as? EventStoreError, .unknownFutureSchemaVersion(99))
    }
  }

  func testMigrationIdempotent() throws {
    let engine = SchemaMigrationEngine(auditSink: RecordingMigrationAuditSink())
    let once = try engine.migrateJSONObject(Self.v0EventObject(), recordKind: "event")
    let twice = try engine.migrateJSONObject(once, recordKind: "event")

    XCTAssertEqual(try canonicalJSONData(once), try canonicalJSONData(twice))
  }

  private static var v0EventFixture: Data {
    get throws {
      try canonicalJSONData(v0EventObject())
    }
  }

  private static func v0EventObject() -> [String: Any] {
    [
      "eventId": "018f2b9c-7c00-7000-8000-000000000001",
      "taskId": "task-migration",
      "parentEventId": NSNull(),
      "timestamp": "2026-04-29T18:00:00.000Z",
      "eventType": "task_created",
      "payload": ["legacy": true],
      "prevHash": EventRecord.emptyPreviousHash,
      "hmac": "legacy-fixture-hmac"
    ]
  }

  private static func v1EventObject() throws -> [String: Any] {
    var object = v0EventObject()
    object["schemaVersion"] = 1
    return object
  }
}
