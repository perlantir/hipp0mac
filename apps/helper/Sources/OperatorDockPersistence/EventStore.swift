import Foundation

public final class EventStore: @unchecked Sendable {
  private let paths: OperatorDockPaths
  private let keys: PersistenceKeys
  private let codec: AESGCMRecordCodec
  private let factory: EventRecordFactory
  private let idGenerator: UUIDV7Generator
  private let fsyncRecorder: FsyncRecorder
  private let lock = NSLock()

  public init(
    paths: OperatorDockPaths,
    keys: PersistenceKeys,
    fsyncRecorder: FsyncRecorder = FsyncRecorder(),
    idGenerator: UUIDV7Generator = UUIDV7Generator()
  ) {
    self.paths = paths
    self.keys = keys
    self.codec = AESGCMRecordCodec(keys: keys)
    self.factory = EventRecordFactory(keys: keys)
    self.idGenerator = idGenerator
    self.fsyncRecorder = fsyncRecorder
  }

  @discardableResult
  public func append(
    taskId: String,
    eventType: String,
    payload: [String: JSONValue]
  ) throws -> String {
    lock.lock()
    defer { lock.unlock() }

    let url = logURL(taskId: taskId)
    try verify(taskId: taskId)
    let last = try lastRecord(taskId: taskId)
    let event = try factory.make(
      taskId: taskId,
      eventType: eventType,
      payload: payload,
      previous: last?.event,
      previousBytes: last?.raw.bytes,
      idGenerator: idGenerator
    )
    let encrypted = try codec.seal(event.encoded()).bytes
    try EncryptedRecordFile.appendRecord(
      encrypted,
      to: url,
      eventId: event.eventId,
      fsyncRecorder: fsyncRecorder
    )
    return event.eventId
  }

  public func readAll(taskId: String) throws -> [EventRecord] {
    let decoded = try decodedRecords(taskId: taskId)
    try verifyDecoded(decoded)
    return decoded.map(\.event)
  }

  public func readSince(taskId: String, eventId: String) throws -> [EventRecord] {
    let events = try readAll(taskId: taskId)
    guard let index = events.firstIndex(where: { $0.eventId == eventId }) else {
      return []
    }
    return Array(events.dropFirst(index + 1))
  }

  public func verify(taskId: String) throws {
    try verifyDecoded(decodedRecords(taskId: taskId))
  }

  private func verifyDecoded(_ decoded: [(raw: RawEncryptedRecord, event: EventRecord)]) throws {
    var previousEvent: EventRecord?
    var previousBytes: Data?

    for item in decoded {
      let event = item.event
      if event.schemaVersion > EventRecord.currentSchemaVersion {
        throw EventStoreError.unknownFutureSchemaVersion(event.schemaVersion)
      }

      if event.parentEventId != previousEvent?.eventId {
        throw EventStoreError.corruption(eventId: event.eventId, reason: "parentEventId does not match previous event")
      }

      let expectedPrevHash = previousBytes.map(sha256Hex(_:)) ?? EventRecord.emptyPreviousHash
      if event.prevHash != expectedPrevHash {
        throw EventStoreError.corruption(eventId: event.eventId, reason: "prevHash does not match previous record bytes")
      }

      let expectedHMAC = try computeHMAC(for: event, keys: keys)
      if event.hmac != expectedHMAC {
        throw EventStoreError.corruption(eventId: event.eventId, reason: "hmac does not match canonical record")
      }

      previousEvent = event
      previousBytes = item.raw.bytes
    }
  }

  private func lastRecord(taskId: String) throws -> (raw: RawEncryptedRecord, event: EventRecord)? {
    try decodedRecords(taskId: taskId).last
  }

  private func decodedRecords(taskId: String) throws -> [(raw: RawEncryptedRecord, event: EventRecord)] {
    let result = try EncryptedRecordFile.readRecords(from: logURL(taskId: taskId), codec: codec)
    return try result.records.map { raw in
      (raw, try EventRecord.decode(from: codec.open(raw.bytes)))
    }
  }

  private func logURL(taskId: String) -> URL {
    paths.eventStore.appendingPathComponent("\(taskId).log")
  }
}
