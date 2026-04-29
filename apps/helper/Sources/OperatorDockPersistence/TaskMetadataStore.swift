import Foundation

public enum TaskState: String, Codable, Equatable, Sendable {
  case created
  case paused
  case completed
  case failed
  case cancelled
}

public struct TaskMetadataRecord: Codable, Equatable, Sendable {
  public static let currentSchemaVersion = 1

  public let schemaVersion: Int
  public let taskId: String
  public let createdAt: String
  public let state: TaskState
  public let lastEventId: String?
  public let lastCheckpointId: String?

  public init(
    schemaVersion: Int = TaskMetadataRecord.currentSchemaVersion,
    taskId: String,
    createdAt: String,
    state: TaskState,
    lastEventId: String?,
    lastCheckpointId: String?
  ) {
    self.schemaVersion = schemaVersion
    self.taskId = taskId
    self.createdAt = createdAt
    self.state = state
    self.lastEventId = lastEventId
    self.lastCheckpointId = lastCheckpointId
  }
}

public final class TaskMetadataStore: @unchecked Sendable {
  private let paths: OperatorDockPaths
  private let codec: AESGCMRecordCodec
  private let eventStore: EventStore
  private let fsyncRecorder: FsyncRecorder

  public init(
    paths: OperatorDockPaths,
    keys: PersistenceKeys,
    eventStore: EventStore,
    fsyncRecorder: FsyncRecorder = FsyncRecorder()
  ) {
    self.paths = paths
    self.codec = AESGCMRecordCodec(keys: keys)
    self.eventStore = eventStore
    self.fsyncRecorder = fsyncRecorder
  }

  public func createTask(taskId: String = UUID().uuidString) throws -> TaskMetadataRecord {
    let eventId = try eventStore.append(
      taskId: taskId,
      eventType: "task_created",
      payload: [
        "taskId": .string(taskId),
        "state": .string(TaskState.created.rawValue)
      ]
    )
    let record = TaskMetadataRecord(
      taskId: taskId,
      createdAt: iso8601Milliseconds(),
      state: .created,
      lastEventId: eventId,
      lastCheckpointId: nil
    )
    try write(record)
    return record
  }

  public func transition(taskId: String, to state: TaskState) throws -> TaskMetadataRecord {
    guard let current = try loadTask(taskId: taskId) else {
      throw LockControllerError.lockNotFound
    }

    let eventId = try eventStore.append(
      taskId: taskId,
      eventType: "task_state_transition",
      payload: [
        "from": .string(current.state.rawValue),
        "to": .string(state.rawValue)
      ]
    )
    let updated = TaskMetadataRecord(
      taskId: current.taskId,
      createdAt: current.createdAt,
      state: state,
      lastEventId: eventId,
      lastCheckpointId: current.lastCheckpointId
    )
    try write(updated)
    return updated
  }

  public func recordCheckpoint(taskId: String, checkpointEventId: String) throws -> TaskMetadataRecord {
    guard let current = try loadTask(taskId: taskId) else {
      throw LockControllerError.lockNotFound
    }

    let updated = TaskMetadataRecord(
      taskId: current.taskId,
      createdAt: current.createdAt,
      state: current.state,
      lastEventId: current.lastEventId,
      lastCheckpointId: checkpointEventId
    )
    try write(updated)
    return updated
  }

  public func loadTask(taskId: String) throws -> TaskMetadataRecord? {
    let url = metadataURL(taskId: taskId)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }
    let record = try JSONDecoder().decode(TaskMetadataRecord.self, from: codec.open(Data(contentsOf: url)))
    if record.schemaVersion > TaskMetadataRecord.currentSchemaVersion {
      throw EventStoreError.unknownFutureSchemaVersion(record.schemaVersion)
    }
    return record
  }

  private func write(_ record: TaskMetadataRecord) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let encrypted = try codec.seal(encoder.encode(record)).bytes
    try syncWriteFile(encrypted, to: metadataURL(taskId: record.taskId), fsyncRecorder: fsyncRecorder, eventId: record.lastEventId ?? record.taskId)
  }

  private func metadataURL(taskId: String) -> URL {
    paths.tasks.appendingPathComponent("\(taskId).json")
  }
}
