import Foundation
import XCTest
@testable import OperatorDockPersistence

final class TaskMetadataStoreTests: XCTestCase {
  func testCreateTaskPersistsEncryptedMetadataAndEmitsEvent() throws {
    let harness = try TaskMetadataHarness()

    let metadata = try harness.tasks.createTask(taskId: "task-meta")

    XCTAssertEqual(metadata.schemaVersion, 1)
    XCTAssertEqual(metadata.state, .created)
    XCTAssertNotNil(metadata.lastEventId)
    XCTAssertEqual(try harness.eventStore.readAll(taskId: "task-meta").first?.eventType, "task_created")

    let raw = try Data(contentsOf: harness.paths.tasks.appendingPathComponent("task-meta.json"))
    let rawText = String(decoding: raw, as: UTF8.self)
    XCTAssertFalse(rawText.contains("task-meta"))
    XCTAssertFalse(rawText.contains("created"))
  }

  func testStateTransitionEmitsEventAndUpdatesMetadata() throws {
    let harness = try TaskMetadataHarness()
    _ = try harness.tasks.createTask(taskId: "task-transition")

    let paused = try harness.tasks.transition(taskId: "task-transition", to: .paused)
    let completed = try harness.tasks.transition(taskId: "task-transition", to: .completed)

    XCTAssertEqual(paused.state, .paused)
    XCTAssertEqual(completed.state, .completed)
    XCTAssertEqual(try harness.tasks.loadTask(taskId: "task-transition")?.state, .completed)
    XCTAssertEqual(
      try harness.eventStore.readAll(taskId: "task-transition").map(\.eventType),
      ["task_created", "task_state_transition", "task_state_transition"]
    )
  }

  func testMetadataTracksLastEventAndCheckpointIds() throws {
    let harness = try TaskMetadataHarness()
    _ = try harness.tasks.createTask(taskId: "task-checkpoint-meta")
    let transitioned = try harness.tasks.transition(taskId: "task-checkpoint-meta", to: .paused)

    let updated = try harness.tasks.recordCheckpoint(
      taskId: "task-checkpoint-meta",
      checkpointEventId: transitioned.lastEventId!
    )

    XCTAssertEqual(updated.lastEventId, transitioned.lastEventId)
    XCTAssertEqual(updated.lastCheckpointId, transitioned.lastEventId)
  }
}

private final class TaskMetadataHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x77, count: 32),
    hmacKeyBytes: Data(repeating: 0x88, count: 32)
  )
  let eventStore: EventStore
  let tasks: TaskMetadataStore

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-tasks-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    tasks = TaskMetadataStore(paths: paths, keys: keys, eventStore: eventStore)
  }
}
