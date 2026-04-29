import Darwin
import Foundation

public enum LockControllerError: Error, Equatable, LocalizedError {
  case alreadyHeld
  case lockNotFound
  case notOwner
  case malformedLock

  public var errorDescription: String? {
    switch self {
    case .alreadyHeld:
      "Task lock is already held by another daemon instance."
    case .lockNotFound:
      "Task lock does not exist."
    case .notOwner:
      "Task lock is owned by another daemon instance."
    case .malformedLock:
      "Task lock file is malformed."
    }
  }
}

public protocol ClockDriver: Sendable {
  var now: Date { get }
  func sleep(seconds: TimeInterval)
}

public struct SystemClock: ClockDriver {
  public init() {}

  public var now: Date {
    Date()
  }

  public func sleep(seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }
}

public final class TestClock: ClockDriver, @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  public init(start: Date) {
    current = start
  }

  public var now: Date {
    lock.lock()
    defer { lock.unlock() }
    return current
  }

  public func sleep(seconds: TimeInterval) {
    advance(seconds: seconds)
  }

  public func advance(seconds: TimeInterval) {
    lock.lock()
    current = current.addingTimeInterval(seconds)
    lock.unlock()
  }
}

public struct TaskLockRecord: Codable, Equatable, Sendable {
  public static let currentSchemaVersion = 1

  public let schemaVersion: Int
  public let daemonInstanceId: String
  public let pid: Int32
  public let acquiredAt: String
  public let lastHeartbeat: String

  public init(
    schemaVersion: Int = TaskLockRecord.currentSchemaVersion,
    daemonInstanceId: String,
    pid: Int32,
    acquiredAt: String,
    lastHeartbeat: String
  ) {
    self.schemaVersion = schemaVersion
    self.daemonInstanceId = daemonInstanceId
    self.pid = pid
    self.acquiredAt = acquiredAt
    self.lastHeartbeat = lastHeartbeat
  }
}

public struct LockHandle: Sendable {
  public let taskId: String
  public let daemonInstanceId: String
}

public final class LockController: @unchecked Sendable {
  public let daemonInstanceId: String

  private let paths: OperatorDockPaths
  private let eventStore: EventStore
  private let clock: ClockDriver
  private let pid: Int32
  private let staleAfter: TimeInterval

  public init(
    paths: OperatorDockPaths,
    eventStore: EventStore,
    clock: ClockDriver = SystemClock(),
    daemonInstanceId: String = UUID().uuidString,
    pid: Int32 = getpid(),
    staleAfter: TimeInterval = 30
  ) {
    self.paths = paths
    self.eventStore = eventStore
    self.clock = clock
    self.daemonInstanceId = daemonInstanceId
    self.pid = pid
    self.staleAfter = staleAfter
  }

  public func acquire(taskId: String) throws -> LockHandle {
    let record = makeRecord(acquiredAt: clock.now)
    if try createLockFile(taskId: taskId, record: record) {
      try emit(taskId: taskId, eventType: "lock_acquired", record: record)
      return LockHandle(taskId: taskId, daemonInstanceId: daemonInstanceId)
    }

    guard let existing = try readLock(taskId: taskId) else {
      return try acquire(taskId: taskId)
    }
    if isFresh(existing) {
      throw LockControllerError.alreadyHeld
    }

    return try reclaim(taskId: taskId, previous: existing, replacement: record)
  }

  public func heartbeat(_ handle: LockHandle) throws {
    guard var record = try readLock(taskId: handle.taskId) else {
      throw LockControllerError.lockNotFound
    }
    guard record.daemonInstanceId == handle.daemonInstanceId else {
      throw LockControllerError.notOwner
    }

    record = TaskLockRecord(
      daemonInstanceId: record.daemonInstanceId,
      pid: record.pid,
      acquiredAt: record.acquiredAt,
      lastHeartbeat: iso8601Milliseconds(date: clock.now)
    )
    try writeLockFile(taskId: handle.taskId, record: record)
    try eventStore.append(
      taskId: handle.taskId,
      eventType: "daemon_heartbeat",
      payload: [
        "daemonInstanceId": .string(daemonInstanceId),
        "pid": .number(Double(pid))
      ]
    )
  }

  public func release(_ handle: LockHandle) throws {
    guard let record = try readLock(taskId: handle.taskId) else {
      throw LockControllerError.lockNotFound
    }
    guard record.daemonInstanceId == handle.daemonInstanceId else {
      throw LockControllerError.notOwner
    }

    try FileManager.default.removeItem(at: lockURL(taskId: handle.taskId))
    try eventStore.append(
      taskId: handle.taskId,
      eventType: "lock_released",
      payload: [
        "daemonInstanceId": .string(daemonInstanceId),
        "pid": .number(Double(pid))
      ]
    )
  }

  public func readLock(taskId: String) throws -> TaskLockRecord? {
    let url = lockURL(taskId: taskId)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    do {
      let record = try JSONDecoder().decode(TaskLockRecord.self, from: Data(contentsOf: url))
      guard record.schemaVersion <= TaskLockRecord.currentSchemaVersion else {
        throw EventStoreError.unknownFutureSchemaVersion(record.schemaVersion)
      }
      return record
    } catch let error as EventStoreError {
      throw error
    } catch {
      throw LockControllerError.malformedLock
    }
  }

  private func reclaim(taskId: String, previous: TaskLockRecord, replacement: TaskLockRecord) throws -> LockHandle {
    try withReclaimGuard(taskId: taskId) {
      clock.sleep(seconds: 1)
      guard let secondRead = try readLock(taskId: taskId) else {
        return try acquire(taskId: taskId)
      }
      if isFresh(secondRead) {
        throw LockControllerError.alreadyHeld
      }

      try FileManager.default.removeItem(at: lockURL(taskId: taskId))
      guard try createLockFile(taskId: taskId, record: replacement) else {
        throw LockControllerError.alreadyHeld
      }
      try eventStore.append(
        taskId: taskId,
        eventType: "lock_reclaimed",
        payload: [
          "previousDaemonInstanceId": .string(previous.daemonInstanceId),
          "previousPid": .number(Double(previous.pid)),
          "newDaemonInstanceId": .string(daemonInstanceId)
        ]
      )
      try emit(taskId: taskId, eventType: "lock_acquired", record: replacement)
      return LockHandle(taskId: taskId, daemonInstanceId: daemonInstanceId)
    }
  }

  private func withReclaimGuard<T>(taskId: String, operation: () throws -> T) throws -> T {
    let url = paths.locks.appendingPathComponent("\(taskId).reclaim-lock", isDirectory: true)
    try FileManager.default.createDirectory(at: paths.locks, withIntermediateDirectories: true)
    guard Darwin.mkdir(url.path, S_IRWXU) == 0 else {
      throw LockControllerError.alreadyHeld
    }
    defer {
      try? FileManager.default.removeItem(at: url)
    }
    return try operation()
  }

  private func emit(taskId: String, eventType: String, record: TaskLockRecord) throws {
    try eventStore.append(
      taskId: taskId,
      eventType: eventType,
      payload: [
        "daemonInstanceId": .string(record.daemonInstanceId),
        "pid": .number(Double(record.pid)),
        "acquiredAt": .string(record.acquiredAt),
        "lastHeartbeat": .string(record.lastHeartbeat)
      ]
    )
  }

  private func createLockFile(taskId: String, record: TaskLockRecord) throws -> Bool {
    try FileManager.default.createDirectory(at: paths.locks, withIntermediateDirectories: true)
    let fd = Darwin.open(lockURL(taskId: taskId).path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    if fd == -1 && errno == EEXIST {
      return false
    }
    guard fd >= 0 else {
      throw EventStoreError.writeFailed(String(cString: strerror(errno)))
    }
    defer {
      Darwin.close(fd)
    }
    try write(record, toFileDescriptor: fd)
    return true
  }

  private func writeLockFile(taskId: String, record: TaskLockRecord) throws {
    let fd = Darwin.open(lockURL(taskId: taskId).path, O_WRONLY | O_TRUNC)
    guard fd >= 0 else {
      throw EventStoreError.writeFailed(String(cString: strerror(errno)))
    }
    defer {
      Darwin.close(fd)
    }
    try write(record, toFileDescriptor: fd)
  }

  private func write(_ record: TaskLockRecord, toFileDescriptor fd: Int32) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(record)
    try data.withUnsafeBytes { buffer in
      guard let baseAddress = buffer.baseAddress else {
        return
      }
      var written = 0
      while written < data.count {
        let result = Darwin.write(fd, baseAddress.advanced(by: written), data.count - written)
        guard result > 0 else {
          throw EventStoreError.writeFailed(String(cString: strerror(errno)))
        }
        written += result
      }
    }
    guard Darwin.fsync(fd) == 0 else {
      throw EventStoreError.writeFailed(String(cString: strerror(errno)))
    }
  }

  private func makeRecord(acquiredAt: Date) -> TaskLockRecord {
    let timestamp = iso8601Milliseconds(date: acquiredAt)
    return TaskLockRecord(
      daemonInstanceId: daemonInstanceId,
      pid: pid,
      acquiredAt: timestamp,
      lastHeartbeat: timestamp
    )
  }

  private func isFresh(_ record: TaskLockRecord) -> Bool {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let heartbeat = formatter.date(from: record.lastHeartbeat) else {
      return false
    }
    return clock.now.timeIntervalSince(heartbeat) < staleAfter
  }

  private func lockURL(taskId: String) -> URL {
    paths.locks.appendingPathComponent("\(taskId).lock")
  }
}
