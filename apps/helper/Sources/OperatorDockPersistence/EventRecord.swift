import CryptoKit
import Foundation

public enum EventStoreError: Error, Equatable, LocalizedError {
  case corruption(eventId: String?, reason: String)
  case unknownFutureSchemaVersion(Int)
  case writeFailed(String)

  public var errorDescription: String? {
    switch self {
    case .corruption(let eventId, let reason):
      "Event store corruption\(eventId.map { " at \($0)" } ?? ""): \(reason)"
    case .unknownFutureSchemaVersion(let version):
      "Cannot load future schemaVersion \(version)."
    case .writeFailed(let message):
      "Event store write failed: \(message)"
    }
  }
}

public struct EventRecord: Codable, Equatable, Sendable {
  public static let currentSchemaVersion = 1
  public static let emptyPreviousHash = String(repeating: "0", count: 64)

  public var schemaVersion: Int
  public var eventId: String
  public var taskId: String
  public var parentEventId: String?
  public var timestamp: String
  public var eventType: String
  public var payload: [String: JSONValue]
  public var prevHash: String
  public var hmac: String

  public init(
    schemaVersion: Int = EventRecord.currentSchemaVersion,
    eventId: String,
    taskId: String,
    parentEventId: String?,
    timestamp: String,
    eventType: String,
    payload: [String: JSONValue],
    prevHash: String,
    hmac: String
  ) {
    self.schemaVersion = schemaVersion
    self.eventId = eventId
    self.taskId = taskId
    self.parentEventId = parentEventId
    self.timestamp = timestamp
    self.eventType = eventType
    self.payload = payload
    self.prevHash = prevHash
    self.hmac = hmac
  }

  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  public static func decode(from data: Data) throws -> EventRecord {
    try JSONDecoder().decode(EventRecord.self, from: data)
  }

  func hmacPayload() throws -> Data {
    var copy = self
    copy.hmac = ""
    return try copy.encoded()
  }
}

public struct EventRecordFactory: Sendable {
  private let keys: PersistenceKeys

  public init(keys: PersistenceKeys) {
    self.keys = keys
  }

  public func make(
    taskId: String,
    eventType: String,
    payload: [String: JSONValue],
    previous: EventRecord?,
    previousBytes: Data?,
    idGenerator: UUIDV7Generator
  ) throws -> EventRecord {
    let previousHash = previousBytes.map(sha256Hex(_:)) ?? EventRecord.emptyPreviousHash
    var record = EventRecord(
      eventId: idGenerator.next(),
      taskId: taskId,
      parentEventId: previous?.eventId,
      timestamp: iso8601Milliseconds(),
      eventType: eventType,
      payload: payload,
      prevHash: previousHash,
      hmac: ""
    )
    record.hmac = try computeHMAC(for: record, keys: keys)
    return record
  }
}

func computeHMAC(for record: EventRecord, keys: PersistenceKeys) throws -> String {
  try keys.validate()
  let code = HMAC<SHA256>.authenticationCode(
    for: try record.hmacPayload(),
    using: SymmetricKey(data: keys.hmacKeyBytes)
  )
  return Data(code).hexString
}

func sha256Hex(_ data: Data) -> String {
  Data(SHA256.hash(data: data)).hexString
}

func iso8601Milliseconds(date: Date = Date()) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

extension Data {
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
