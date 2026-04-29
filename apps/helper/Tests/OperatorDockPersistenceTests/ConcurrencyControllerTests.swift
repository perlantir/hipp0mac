import Foundation
import XCTest
@testable import OperatorDockPersistence

final class ConcurrencyControllerTests: XCTestCase {
  func testExclusiveAcquire() throws {
    let harness = try LockHarness()
    let first = try harness.controller.acquire(taskId: "task-lock")

    XCTAssertThrowsError(try harness.otherController.acquire(taskId: "task-lock")) { error in
      XCTAssertEqual(error as? LockControllerError, .alreadyHeld)
    }

    try harness.controller.release(first)
  }

  func testHeartbeatKeepsLockAliveForSixtySeconds() throws {
    let harness = try LockHarness()
    let handle = try harness.controller.acquire(taskId: "task-heartbeat")

    for _ in 0..<12 {
      harness.clock.advance(seconds: 5)
      try harness.controller.heartbeat(handle)
      XCTAssertThrowsError(try harness.otherController.acquire(taskId: "task-heartbeat")) { error in
        XCTAssertEqual(error as? LockControllerError, .alreadyHeld)
      }
    }

    try harness.controller.release(handle)
  }

  func testStaleLockReclaimed() throws {
    let harness = try LockHarness()
    _ = try harness.controller.acquire(taskId: "task-stale")

    harness.clock.advance(seconds: 35)
    let reclaimed = try harness.otherController.acquire(taskId: "task-stale")

    XCTAssertEqual(reclaimed.daemonInstanceId, harness.otherController.daemonInstanceId)
    let events = try harness.eventStore.readAll(taskId: "task-stale")
    XCTAssertTrue(events.contains { $0.eventType == "lock_reclaimed" })
  }

  func testReclaimRaceSafety() throws {
    let harness = try LockHarness()
    _ = try harness.controller.acquire(taskId: "task-race")
    harness.clock.advance(seconds: 35)

    let group = DispatchGroup()
    let queue = DispatchQueue(label: "lock-reclaim-race", attributes: .concurrent)
    let results = LockRaceResults()
    for controller in [harness.otherController, harness.thirdController] {
      group.enter()
      queue.async {
        defer { group.leave() }
        do {
          _ = try controller.acquire(taskId: "task-race")
          results.succeeded()
        } catch {
          results.failed(error)
        }
      }
    }
    group.wait()

    XCTAssertEqual(results.successCount, 1)
    XCTAssertEqual(results.failureCount, 1)
  }

  func testLockReleaseEmitsEvent() throws {
    let harness = try LockHarness()
    let handle = try harness.controller.acquire(taskId: "task-release")

    try harness.controller.release(handle)

    XCTAssertTrue(try harness.eventStore.readAll(taskId: "task-release").contains { $0.eventType == "lock_released" })
  }

  func testDaemonInstanceIdRecordedInLockAndHeartbeatEvents() throws {
    let harness = try LockHarness()
    let handle = try harness.controller.acquire(taskId: "task-instance")

    try harness.controller.heartbeat(handle)

    let lock = try harness.controller.readLock(taskId: "task-instance")
    XCTAssertEqual(lock?.daemonInstanceId, harness.controller.daemonInstanceId)

    let heartbeat = try XCTUnwrap(harness.eventStore.readAll(taskId: "task-instance").last {
      $0.eventType == "daemon_heartbeat"
    })
    XCTAssertEqual(heartbeat.payload["daemonInstanceId"], .string(harness.controller.daemonInstanceId))
  }
}

private final class LockHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x55, count: 32),
    hmacKeyBytes: Data(repeating: 0x66, count: 32)
  )
  let clock = TestClock(start: Date(timeIntervalSince1970: 1_777_000_000))
  let eventStore: EventStore
  let controller: LockController
  let otherController: LockController
  let thirdController: LockController

  init() throws {
    paths = try OperatorDockPaths(root: FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-locks-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    controller = LockController(paths: paths, eventStore: eventStore, clock: clock, daemonInstanceId: "daemon-a", pid: 101)
    otherController = LockController(paths: paths, eventStore: eventStore, clock: clock, daemonInstanceId: "daemon-b", pid: 202)
    thirdController = LockController(paths: paths, eventStore: eventStore, clock: clock, daemonInstanceId: "daemon-c", pid: 303)
  }
}

private final class LockRaceResults: @unchecked Sendable {
  private let lock = NSLock()
  private var successes = 0
  private var failures: [Error] = []

  var successCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return successes
  }

  var failureCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return failures.count
  }

  func succeeded() {
    lock.lock()
    successes += 1
    lock.unlock()
  }

  func failed(_ error: Error) {
    lock.lock()
    failures.append(error)
    lock.unlock()
  }
}
