import Foundation
import XCTest
@testable import OperatorDockPersistence

final class CheckpointTests: XCTestCase {
  func testCheckpointRoundTrip() throws {
    let harness = try CheckpointHarness()
    let eventId = try harness.eventStore.append(
      taskId: "task-checkpoint",
      eventType: "task_created",
      payload: ["value": .number(1)]
    )
    let expected = Data("derived-state".utf8)

    try harness.checkpoints.writeCheckpoint(
      taskId: "task-checkpoint",
      eventId: eventId,
      derivedState: expected
    )

    let loaded = try XCTUnwrap(harness.checkpoints.loadCheckpoint(taskId: "task-checkpoint", eventId: eventId))
    XCTAssertEqual(loaded.schemaVersion, 1)
    XCTAssertEqual(loaded.eventId, eventId)
    XCTAssertEqual(loaded.derivedState, expected)
  }

  func testCheckpointCorruptionFallsBackToFullReplay() throws {
    let harness = try CheckpointHarness()
    let ids = try harness.appendNumberedEvents(taskId: "task-corrupt", count: 4)
    try harness.checkpoints.writeCheckpoint(
      taskId: "task-corrupt",
      eventId: ids[2],
      derivedState: Data("0,1,2".utf8)
    )
    try harness.flipCheckpointByte(taskId: "task-corrupt", eventId: ids[2])

    let recovered = try harness.recovery.recover(taskId: "task-corrupt", reducer: numberedStateReducer)

    XCTAssertEqual(recovered, Data("0,1,2,3".utf8))
  }

  func testReplayFromCheckpointMatchesFullReplay() throws {
    let harness = try CheckpointHarness()
    let ids = try harness.appendNumberedEvents(taskId: "task-replay", count: 8)
    try harness.checkpoints.writeCheckpoint(
      taskId: "task-replay",
      eventId: ids[4],
      derivedState: Data("0,1,2,3,4".utf8)
    )

    let fromCheckpoint = try harness.recovery.recover(taskId: "task-replay", reducer: numberedStateReducer)
    let fullReplay = try numberedStateReducer(nil, harness.eventStore.readAll(taskId: "task-replay"))

    XCTAssertEqual(fromCheckpoint, fullReplay)
  }

  func testNoCheckpointPresentUsesFullReplay() throws {
    let harness = try CheckpointHarness()
    _ = try harness.appendNumberedEvents(taskId: "task-no-checkpoint", count: 3)

    let recovered = try harness.recovery.recover(taskId: "task-no-checkpoint", reducer: numberedStateReducer)

    XCTAssertEqual(recovered, Data("0,1,2".utf8))
  }
}

private final class CheckpointHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x33, count: 32),
    hmacKeyBytes: Data(repeating: 0x44, count: 32)
  )
  let eventStore: EventStore
  let checkpoints: CheckpointStore
  let recovery: CheckpointRecovery

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-checkpoints-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    checkpoints = CheckpointStore(paths: paths, keys: keys)
    recovery = CheckpointRecovery(eventStore: eventStore, checkpoints: checkpoints)
  }

  func appendNumberedEvents(taskId: String, count: Int) throws -> [String] {
    try (0..<count).map { index in
      try eventStore.append(
        taskId: taskId,
        eventType: "task_state_transition",
        payload: ["index": .number(Double(index))]
      )
    }
  }

  func flipCheckpointByte(taskId: String, eventId: String) throws {
    let url = paths.checkpoints
      .appendingPathComponent(taskId, isDirectory: true)
      .appendingPathComponent("\(eventId).checkpoint")
    var data = try Data(contentsOf: url)
    data[data.count - 1] ^= 0x01
    try data.write(to: url, options: .atomic)
  }
}

private func numberedStateReducer(_ checkpoint: Data?, _ events: [EventRecord]) throws -> Data {
  var values = checkpoint.flatMap { String(data: $0, encoding: .utf8) }
    .map { $0.isEmpty ? [] : $0.split(separator: ",").map(String.init) } ?? []

  for event in events {
    if case let .number(index) = event.payload["index"] {
      values.append("\(Int(index))")
    }
  }

  return Data(values.joined(separator: ",").utf8)
}
