import Darwin
import Foundation

public enum CheckpointStoreError: Error, Equatable, LocalizedError {
  case corrupt(eventId: String?, reason: String)

  public var errorDescription: String? {
    switch self {
    case .corrupt(let eventId, let reason):
      "Checkpoint corruption\(eventId.map { " at \($0)" } ?? ""): \(reason)"
    }
  }
}

public struct CheckpointRecord: Codable, Equatable, Sendable {
  public static let currentSchemaVersion = 1

  public let schemaVersion: Int
  public let taskId: String
  public let eventId: String
  public let derivedState: Data
  public let integrityHash: String

  public init(
    schemaVersion: Int = CheckpointRecord.currentSchemaVersion,
    taskId: String,
    eventId: String,
    derivedState: Data,
    integrityHash: String
  ) {
    self.schemaVersion = schemaVersion
    self.taskId = taskId
    self.eventId = eventId
    self.derivedState = derivedState
    self.integrityHash = integrityHash
  }
}

public final class CheckpointStore: @unchecked Sendable {
  private let paths: OperatorDockPaths
  private let codec: AESGCMRecordCodec
  private let fsyncRecorder: FsyncRecorder

  public init(
    paths: OperatorDockPaths,
    keys: PersistenceKeys,
    fsyncRecorder: FsyncRecorder = FsyncRecorder()
  ) {
    self.paths = paths
    self.codec = AESGCMRecordCodec(keys: keys)
    self.fsyncRecorder = fsyncRecorder
  }

  public func writeCheckpoint(taskId: String, eventId: String, derivedState: Data) throws {
    let record = CheckpointRecord(
      taskId: taskId,
      eventId: eventId,
      derivedState: derivedState,
      integrityHash: checkpointHash(schemaVersion: CheckpointRecord.currentSchemaVersion, taskId: taskId, eventId: eventId, derivedState: derivedState)
    )
    let encrypted = try codec.seal(record.encoded()).bytes
    try syncWriteFile(encrypted, to: checkpointURL(taskId: taskId, eventId: eventId), fsyncRecorder: fsyncRecorder, eventId: eventId)
  }

  public func latestCheckpoint(taskId: String) throws -> CheckpointRecord? {
    let directory = checkpointsDirectory(taskId: taskId)
    guard FileManager.default.fileExists(atPath: directory.path) else {
      return nil
    }

    let candidates = try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    )
      .filter { $0.pathExtension == "checkpoint" }
      .sorted { $0.lastPathComponent > $1.lastPathComponent }

    for candidate in candidates {
      let eventId = candidate.deletingPathExtension().lastPathComponent
      do {
        return try loadCheckpoint(taskId: taskId, eventId: eventId)
      } catch is CheckpointStoreError {
        continue
      } catch is PersistenceSecurityError {
        continue
      }
    }

    return nil
  }

  public func loadCheckpoint(taskId: String, eventId: String) throws -> CheckpointRecord? {
    let url = checkpointURL(taskId: taskId, eventId: eventId)
    guard FileManager.default.fileExists(atPath: url.path) else {
      return nil
    }

    let plaintext: Data
    do {
      plaintext = try codec.open(Data(contentsOf: url))
    } catch {
      throw CheckpointStoreError.corrupt(eventId: eventId, reason: "authentication failed")
    }

    let record = try CheckpointRecord.decode(from: plaintext)
    try validate(record)
    return record
  }

  private func validate(_ record: CheckpointRecord) throws {
    if record.schemaVersion > CheckpointRecord.currentSchemaVersion {
      throw EventStoreError.unknownFutureSchemaVersion(record.schemaVersion)
    }

    let expected = checkpointHash(
      schemaVersion: record.schemaVersion,
      taskId: record.taskId,
      eventId: record.eventId,
      derivedState: record.derivedState
    )
    guard record.integrityHash == expected else {
      throw CheckpointStoreError.corrupt(eventId: record.eventId, reason: "integrity hash mismatch")
    }
  }

  private func checkpointsDirectory(taskId: String) -> URL {
    paths.checkpoints.appendingPathComponent(taskId, isDirectory: true)
  }

  private func checkpointURL(taskId: String, eventId: String) -> URL {
    checkpointsDirectory(taskId: taskId).appendingPathComponent("\(eventId).checkpoint")
  }
}

public struct CheckpointRecovery: Sendable {
  private let eventStore: EventStore
  private let checkpoints: CheckpointStore

  public init(eventStore: EventStore, checkpoints: CheckpointStore) {
    self.eventStore = eventStore
    self.checkpoints = checkpoints
  }

  public func recover(
    taskId: String,
    reducer: (Data?, [EventRecord]) throws -> Data
  ) throws -> Data {
    if let checkpoint = try checkpoints.latestCheckpoint(taskId: taskId) {
      return try reducer(checkpoint.derivedState, eventStore.readSince(taskId: taskId, eventId: checkpoint.eventId))
    }

    return try reducer(nil, eventStore.readAll(taskId: taskId))
  }
}

extension CheckpointRecord {
  func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(self)
  }

  static func decode(from data: Data) throws -> CheckpointRecord {
    try JSONDecoder().decode(CheckpointRecord.self, from: data)
  }
}

func checkpointHash(schemaVersion: Int, taskId: String, eventId: String, derivedState: Data) -> String {
  sha256Hex(Data("\(schemaVersion)|\(taskId)|\(eventId)|\(derivedState.hexString)".utf8))
}

func syncWriteFile(_ data: Data, to url: URL, fsyncRecorder: FsyncRecorder, eventId: String) throws {
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let fd = Darwin.open(url.path, O_CREAT | O_WRONLY | O_TRUNC, S_IRUSR | S_IWUSR)
  guard fd >= 0 else {
    throw EventStoreError.writeFailed(String(cString: strerror(errno)))
  }
  defer {
    Darwin.close(fd)
  }

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

  fsyncRecorder.record(.fsyncStarted)
  guard Darwin.fsync(fd) == 0 else {
    throw EventStoreError.writeFailed(String(cString: strerror(errno)))
  }
  fsyncRecorder.record(.fsyncCompleted)
  fsyncRecorder.record(.appendReturned(eventId))
}
