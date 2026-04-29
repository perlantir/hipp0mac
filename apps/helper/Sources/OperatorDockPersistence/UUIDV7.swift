import Foundation
import Security

public final class UUIDV7Generator: @unchecked Sendable {
  private let lock = NSLock()
  private var lastMilliseconds: UInt64 = 0

  public init() {}

  public func next() -> String {
    lock.lock()
    defer { lock.unlock() }

    let now = UInt64(Date().timeIntervalSince1970 * 1000)
    let timestamp = max(now, lastMilliseconds + 1)
    lastMilliseconds = timestamp

    var bytes = [UInt8](repeating: 0, count: 16)
    bytes[0] = UInt8((timestamp >> 40) & 0xFF)
    bytes[1] = UInt8((timestamp >> 32) & 0xFF)
    bytes[2] = UInt8((timestamp >> 24) & 0xFF)
    bytes[3] = UInt8((timestamp >> 16) & 0xFF)
    bytes[4] = UInt8((timestamp >> 8) & 0xFF)
    bytes[5] = UInt8(timestamp & 0xFF)

    var random = [UInt8](repeating: 0, count: 10)
    _ = SecRandomCopyBytes(kSecRandomDefault, random.count, &random)
    bytes[6] = 0x70 | (random[0] & 0x0F)
    bytes[7] = random[1]
    bytes[8] = 0x80 | (random[2] & 0x3F)
    bytes[9] = random[3]
    bytes[10] = random[4]
    bytes[11] = random[5]
    bytes[12] = random[6]
    bytes[13] = random[7]
    bytes[14] = random[8]
    bytes[15] = random[9]

    return UUIDV7.format(bytes)
  }
}

public enum UUIDV7 {
  public static func isValid(_ value: String) -> Bool {
    let pattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#
    return value.range(of: pattern, options: .regularExpression) != nil
  }

  static func format(_ bytes: [UInt8]) -> String {
    let hex = bytes.map { String(format: "%02x", $0) }
    return "\(hex[0])\(hex[1])\(hex[2])\(hex[3])-\(hex[4])\(hex[5])-\(hex[6])\(hex[7])-\(hex[8])\(hex[9])-\(hex[10])\(hex[11])\(hex[12])\(hex[13])\(hex[14])\(hex[15])"
  }
}
