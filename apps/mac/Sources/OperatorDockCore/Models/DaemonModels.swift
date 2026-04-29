import Foundation

public enum JSONValue: Codable, Hashable, Sendable {
  case string(String)
  case number(Double)
  case boolean(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .boolean(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()

    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .boolean(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

public enum TaskStatus: String, Codable, Sendable {
  case queued
  case running
  case waitingForApproval = "waiting_for_approval"
  case completed
  case failed
  case cancelled

  public var displayName: String {
    switch self {
    case .queued: "Queued"
    case .running: "Running"
    case .waitingForApproval: "Waiting"
    case .completed: "Completed"
    case .failed: "Failed"
    case .cancelled: "Cancelled"
    }
  }
}

public enum TaskPriority: String, Codable, Sendable {
  case low
  case normal
  case high
}

public struct DockTask: Identifiable, Codable, Hashable, Sendable {
  public let id: UUID
  public let projectId: UUID?
  public let title: String
  public let prompt: String
  public let status: TaskStatus
  public let priority: TaskPriority
  public let metadata: [String: JSONValue]
  public let createdAt: String
  public let updatedAt: String
}

public struct CreateTaskRequest: Encodable, Sendable {
  public let title: String
  public let prompt: String
  public let priority: TaskPriority
  public let metadata: [String: JSONValue]

  public init(
    title: String,
    prompt: String,
    priority: TaskPriority = .normal,
    metadata: [String: JSONValue] = [:]
  ) {
    self.title = title
    self.prompt = prompt
    self.priority = priority
    self.metadata = metadata
  }
}

public struct CreateTaskResponse: Decodable, Sendable {
  public let task: DockTask
}

public struct TaskListResponse: Decodable, Sendable {
  public let tasks: [DockTask]
}

public struct HealthResponse: Decodable, Sendable {
  public let status: String
  public let service: String
  public let version: String
  public let database: String
  public let timestamp: String
}

public enum OperatorEvent: Identifiable, Decodable, Sendable {
  case taskCreated(TaskEventEnvelope)
  case taskUpdated(TaskEventEnvelope)
  case other(GenericEventEnvelope)

  public var id: UUID {
    switch self {
    case .taskCreated(let event): event.id
    case .taskUpdated(let event): event.id
    case .other(let event): event.id
    }
  }

  public var type: String {
    switch self {
    case .taskCreated(let event): event.type
    case .taskUpdated(let event): event.type
    case .other(let event): event.type
    }
  }

  public var occurredAt: String {
    switch self {
    case .taskCreated(let event): event.occurredAt
    case .taskUpdated(let event): event.occurredAt
    case .other(let event): event.occurredAt
    }
  }

  public var task: DockTask? {
    switch self {
    case .taskCreated(let event): event.payload.task
    case .taskUpdated(let event): event.payload.task
    case .other: nil
    }
  }

  public var summary: String {
    if let task {
      return task.title
    }

    return "Event received"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: EventCodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)

    switch type {
    case "task.created":
      self = .taskCreated(try TaskEventEnvelope(from: decoder))
    case "task.updated":
      self = .taskUpdated(try TaskEventEnvelope(from: decoder))
    default:
      self = .other(try GenericEventEnvelope(from: decoder))
    }
  }
}

public struct TaskEventEnvelope: Decodable, Sendable {
  public let id: UUID
  public let type: String
  public let occurredAt: String
  public let payload: TaskEventPayload
}

public struct TaskEventPayload: Decodable, Sendable {
  public let task: DockTask
}

public struct GenericEventEnvelope: Decodable, Sendable {
  public let id: UUID
  public let type: String
  public let occurredAt: String
}

private enum EventCodingKeys: String, CodingKey {
  case type
}

