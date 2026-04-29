import Foundation
import XCTest
@testable import OperatorDockPersistence

final class LifecycleCoordinatorTests: XCTestCase {
  func testDaemonStartAndShutdownEmitPlatformEvents() throws {
    let harness = try LifecycleHarness()

    try harness.lifecycle.daemonStarted()
    try harness.lifecycle.shutdown()

    let platformEvents = try harness.eventStore.readAll(taskId: PlatformEvent.taskId)
    XCTAssertEqual(platformEvents.map(\.eventType), ["daemon_started", "daemon_shutdown"])
    XCTAssertEqual(platformEvents[0].payload["daemonInstanceId"], .string("daemon-life"))
    XCTAssertEqual(platformEvents[1].payload["daemonInstanceId"], .string("daemon-life"))
    XCTAssertEqual(harness.drainCount, 1)
  }

  func testWillSleepDrainsWritesAndPausesHeartbeat() throws {
    let harness = try LifecycleHarness()

    try harness.lifecycle.willSleep()

    XCTAssertTrue(harness.lifecycle.heartbeatsPaused)
    XCTAssertEqual(harness.drainCount, 1)
  }

  func testWakeReloadsKeysAndResumesHeartbeat() throws {
    let harness = try LifecycleHarness()
    try harness.lifecycle.willSleep()

    try harness.lifecycle.didWake()

    XCTAssertFalse(harness.lifecycle.heartbeatsPaused)
    XCTAssertEqual(harness.reloadCount, 1)
  }

  func testWakeDetectsStolenLockAndTransitionsOwnedTaskToPaused() throws {
    let harness = try LifecycleHarness()
    _ = try harness.tasks.createTask(taskId: "task-stolen")
    let handle = try harness.lockController.acquire(taskId: "task-stolen")
    harness.lifecycle.registerOwnedLock(handle)
    try harness.lifecycle.willSleep()
    try harness.overwriteLock(taskId: "task-stolen", daemonInstanceId: "other-daemon")

    try harness.lifecycle.didWake()

    XCTAssertEqual(try harness.tasks.loadTask(taskId: "task-stolen")?.state, .paused)
    XCTAssertTrue(try harness.eventStore.readAll(taskId: "task-stolen").contains { $0.eventType == "lock_lost" })
  }
}

private final class LifecycleHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0xAB, count: 32),
    hmacKeyBytes: Data(repeating: 0xCD, count: 32)
  )
  let clock = TestClock(start: Date(timeIntervalSince1970: 1_777_100_000))
  let eventStore: EventStore
  let lockController: LockController
  let tasks: TaskMetadataStore
  let counters = LifecycleCounters()
  let lifecycle: DaemonLifecycleCoordinator

  var drainCount: Int { counters.drainCount }
  var reloadCount: Int { counters.reloadCount }

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-lifecycle-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    lockController = LockController(paths: paths, eventStore: eventStore, clock: clock, daemonInstanceId: "daemon-life", pid: 404)
    tasks = TaskMetadataStore(paths: paths, keys: keys, eventStore: eventStore)
    lifecycle = DaemonLifecycleCoordinator(
      lockController: lockController,
      taskStore: tasks,
      eventStore: eventStore,
      reloadKeys: { [counters, keys] in
        counters.incrementReload()
        return keys
      },
      drainWrites: { [counters] in
        counters.incrementDrain()
      }
    )
  }

  func overwriteLock(taskId: String, daemonInstanceId: String) throws {
    let record = TaskLockRecord(
      daemonInstanceId: daemonInstanceId,
      pid: 505,
      acquiredAt: iso8601Milliseconds(date: clock.now),
      lastHeartbeat: iso8601Milliseconds(date: clock.now)
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(record).write(to: paths.locks.appendingPathComponent("\(taskId).lock"), options: .atomic)
  }
}

private final class LifecycleCounters: @unchecked Sendable {
  private let lock = NSLock()
  private var drains = 0
  private var reloads = 0

  var drainCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return drains
  }

  var reloadCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return reloads
  }

  func incrementDrain() {
    lock.lock()
    drains += 1
    lock.unlock()
  }

  func incrementReload() {
    lock.lock()
    reloads += 1
    lock.unlock()
  }
}
