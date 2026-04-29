import Darwin
import Foundation

public enum FsyncEvent: Equatable, Sendable {
  case fsyncStarted
  case fsyncCompleted
  case appendReturned(String)
}

public final class FsyncRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [FsyncEvent] = []

  public init() {}

  public var calls: [FsyncEvent] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func record(_ event: FsyncEvent) {
    lock.lock()
    storage.append(event)
    lock.unlock()
  }
}

public struct RawEncryptedRecord: Sendable {
  public let bytes: Data
  public let offset: Int
}

public struct EncryptedRecordReadResult: Sendable {
  public let records: [RawEncryptedRecord]
  public let truncated: Bool
}

public enum EncryptedRecordFile {
  public static func readRecords(
    from url: URL,
    codec: AESGCMRecordCodec,
    truncateIncompleteFinal: Bool = true
  ) throws -> EncryptedRecordReadResult {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return EncryptedRecordReadResult(records: [], truncated: false)
    }

    let data = try Data(contentsOf: url)
    var records: [RawEncryptedRecord] = []
    var offset = 0
    var truncateOffset: Int?

    while offset < data.count {
      guard data.count - offset >= 4 else {
        truncateOffset = offset
        break
      }

      let declaredLength = Int(decodeLength(data[offset..<(offset + 4)]))
      let totalLength = 4 + declaredLength
      guard declaredLength >= 28 else {
        throw PersistenceSecurityError.invalidRecordFormat
      }
      guard offset + totalLength <= data.count else {
        truncateOffset = offset
        break
      }

      records.append(RawEncryptedRecord(bytes: Data(data[offset..<(offset + totalLength)]), offset: offset))
      offset += totalLength
    }

    if let truncateOffset {
      if truncateIncompleteFinal {
        try truncateFile(url: url, length: truncateOffset)
      }
      return EncryptedRecordReadResult(records: records, truncated: true)
    }

    _ = codec
    return EncryptedRecordReadResult(records: records, truncated: false)
  }

  public static func appendRecord(
    _ record: Data,
    to url: URL,
    eventId: String,
    fsyncRecorder: FsyncRecorder
  ) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    let fd = Darwin.open(url.path, O_CREAT | O_WRONLY | O_APPEND, S_IRUSR | S_IWUSR)
    guard fd >= 0 else {
      throw EventStoreError.writeFailed(String(cString: strerror(errno)))
    }
    defer {
      Darwin.close(fd)
    }

    try record.withUnsafeBytes { buffer in
      guard let baseAddress = buffer.baseAddress else {
        return
      }

      var written = 0
      while written < record.count {
        let result = Darwin.write(fd, baseAddress.advanced(by: written), record.count - written)
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

  private static func truncateFile(url: URL, length: Int) throws {
    guard Darwin.truncate(url.path, off_t(length)) == 0 else {
      throw EventStoreError.writeFailed(String(cString: strerror(errno)))
    }
  }
}
