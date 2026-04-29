import Foundation

public final class DaemonLifecycleCoordinator: @unchecked Sendable {
  public private(set) var heartbeatsPaused = false

  private let lockController: LockController
  private let taskStore: TaskMetadataStore
  private let eventStore: EventStore
  private let reloadKeys: () throws -> PersistenceKeys
  private let drainWrites: () throws -> Void
  private var ownedLocks: [LockHandle] = []

  public init(
    lockController: LockController,
    taskStore: TaskMetadataStore,
    eventStore: EventStore,
    reloadKeys: @escaping () throws -> PersistenceKeys,
    drainWrites: @escaping () throws -> Void
  ) {
    self.lockController = lockController
    self.taskStore = taskStore
    self.eventStore = eventStore
    self.reloadKeys = reloadKeys
    self.drainWrites = drainWrites
  }

  public func registerOwnedLock(_ handle: LockHandle) {
    ownedLocks.append(handle)
  }

  public func daemonStarted() throws {
    try eventStore.append(
      taskId: PlatformEvent.taskId,
      eventType: "daemon_started",
      payload: [
        "daemonInstanceId": .string(lockController.daemonInstanceId)
      ]
    )
  }

  public func shutdown() throws {
    try drainWrites()
    try eventStore.append(
      taskId: PlatformEvent.taskId,
      eventType: "daemon_shutdown",
      payload: [
        "daemonInstanceId": .string(lockController.daemonInstanceId)
      ]
    )
  }

  public func willSleep() throws {
    try drainWrites()
    heartbeatsPaused = true
  }

  public func didWake() throws {
    _ = try reloadKeys()
    heartbeatsPaused = false

    for handle in ownedLocks {
      guard let lock = try lockController.readLock(taskId: handle.taskId),
            lock.daemonInstanceId == handle.daemonInstanceId else {
        try eventStore.append(
          taskId: handle.taskId,
          eventType: "lock_lost",
          payload: [
            "expectedDaemonInstanceId": .string(handle.daemonInstanceId)
          ]
        )
        if let metadata = try taskStore.loadTask(taskId: handle.taskId),
           metadata.state != .paused {
          _ = try taskStore.transition(taskId: handle.taskId, to: .paused)
        }
        continue
      }
    }
  }
}
