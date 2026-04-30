import Foundation
import XCTest
@testable import OperatorDockCore

final class DaemonSupervisorTests: XCTestCase {
  func testConfigurationDecodesOldBundleShapeWithNewDefaults() throws {
    let legacyJSON = """
    {
      "executablePath": "/usr/bin/env",
      "arguments": ["node", "/tmp/operator-dock-daemon/index.js"],
      "environment": {
        "OPERATOR_DOCK_HOST": "127.0.0.1",
        "OPERATOR_DOCK_PORT": "4768"
      },
      "workingDirectory": "/tmp/operator-dock",
      "respawnDelaySeconds": 0.5,
      "watchdogIntervalSeconds": 2,
      "healthTimeoutSeconds": 1,
      "startupGraceSeconds": 3,
      "healthFailureThreshold": 1,
      "healthURLString": "http://127.0.0.1:4768/health"
    }
    """

    let config = try JSONDecoder().decode(
      DaemonSupervisor.Configuration.self,
      from: Data(legacyJSON.utf8)
    )

    XCTAssertEqual(config.executablePath, "/usr/bin/env")
    XCTAssertEqual(config.environment["OPERATOR_DOCK_PORT"], "4768")
    XCTAssertEqual(config.maxRespawnDelaySeconds, 30)
    XCTAssertEqual(config.maxRestartFailures, 10)
    XCTAssertEqual(config.restartFailureWindowSeconds, 300)
    XCTAssertEqual(config.logFilePath, DaemonSupervisor.defaultLogFilePath)
    XCTAssertEqual(config.logRotationBytes, 10 * 1024 * 1024)
    XCTAssertEqual(config.logRotationCount, 5)
  }

  func testSupervisorCapturesDaemonStreamsToRotatingLog() async throws {
    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-log-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let logPath = tempRoot.appendingPathComponent("daemon.log").path
    try String(repeating: "x", count: 96).write(toFile: logPath, atomically: true, encoding: .utf8)

    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/bin/sh",
        arguments: ["-c", "printf 'stdout-visible\\n'; printf 'stderr-visible\\n' >&2"],
        respawnDelaySeconds: 0.05,
        logFilePath: logPath,
        logRotationBytes: 64,
        logRotationCount: 2
      )
    )
    try supervisor.start()
    defer { supervisor.stop() }

    let wroteLog = await waitUntil(timeout: 3) {
      guard let contents = try? String(contentsOfFile: logPath, encoding: .utf8) else {
        return false
      }

      return contents.contains("stdout-visible") && contents.contains("stderr-visible")
    }

    XCTAssertTrue(wroteLog)
    XCTAssertTrue(FileManager.default.fileExists(atPath: "\(logPath).1"))
  }

  func testSupervisorRespawnsCrashedChildProcess() async throws {
    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-respawn-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/bin/sleep",
        arguments: ["60"],
        respawnDelaySeconds: 0.05,
        logFilePath: tempRoot.appendingPathComponent("daemon.log").path
      )
    )
    try supervisor.start()
    defer { supervisor.stop() }

    let firstPID = try XCTUnwrap(supervisor.currentProcessIdentifier)
    try supervisor.killForCrashTest()

    let respawned = await waitUntil(timeout: 3) {
      guard let pid = supervisor.currentProcessIdentifier else {
        return false
      }

      return pid != firstPID
    }

    XCTAssertTrue(respawned)
  }

  func testSupervisorBacksOffAndSurfacesFatalErrorForHealthFailureLoop() async throws {
    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-restart-storm-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let recorder = SupervisorNotificationRecorder()
    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/bin/sleep",
        arguments: ["60"],
        respawnDelaySeconds: 0.05,
        maxRespawnDelaySeconds: 0.2,
        watchdogIntervalSeconds: 0.05,
        healthTimeoutSeconds: 0.05,
        startupGraceSeconds: 0.01,
        healthFailureThreshold: 1,
        maxRestartFailures: 3,
        restartFailureWindowSeconds: 5,
        healthURLString: "http://127.0.0.1:9/health",
        logFilePath: tempRoot.appendingPathComponent("daemon.log").path
      )
    )
    let launchObserver = NotificationCenter.default.addObserver(
      forName: .daemonSupervisorDidLaunch,
      object: supervisor,
      queue: nil
    ) { _ in
      recorder.recordLaunch()
    }
    let fatalObserver = NotificationCenter.default.addObserver(
      forName: .daemonSupervisorFatalError,
      object: supervisor,
      queue: nil
    ) { notification in
      recorder.recordFatal(notification.userInfo?[DaemonSupervisorNotificationKey.message] as? String)
    }
    defer {
      NotificationCenter.default.removeObserver(launchObserver)
      NotificationCenter.default.removeObserver(fatalObserver)
    }

    try supervisor.start()
    defer { supervisor.stop() }

    let becameFatal = await waitUntil(timeout: 5) {
      recorder.fatalMessage != nil
    }

    XCTAssertTrue(becameFatal)
    XCTAssertEqual(recorder.launchDates.count, 3)
    XCTAssertTrue(recorder.fatalMessage?.contains("Daemon failed to start") == true)
    XCTAssertTrue(recorder.fatalMessage?.contains("daemon.log") == true)

    let intervals = recorder.launchIntervals()
    XCTAssertEqual(intervals.count, 2)
    if intervals.count == 2 {
      XCTAssertGreaterThanOrEqual(intervals[0], 0.045)
      XCTAssertGreaterThanOrEqual(intervals[1], 0.09)
    }
  }

  func testMacAppSupervisorCrashRecoveryWithNodeDaemon() async throws {
    let root = repositoryRoot()
    let daemonEntry = root.appendingPathComponent("apps/daemon/dist/index.js")
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: daemonEntry.path),
      "Run npm run build before this integration test."
    )

    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-supervision-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let port = Int.random(in: 48_000...62_000)
    let token = "supervision-test-token-\(UUID().uuidString)"
    let encryptionKey = Data(repeating: 0x42, count: 32).base64EncodedString()
    let hmacKey = Data(repeating: 0x24, count: 32).base64EncodedString()
    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/usr/bin/env",
        arguments: ["node", daemonEntry.path],
        environment: [
          "HOME": tempRoot.path,
          "OPERATOR_DOCK_HOST": "127.0.0.1",
          "OPERATOR_DOCK_PORT": "\(port)",
          "OPERATOR_DOCK_TEST_MODE": "1",
          "OPERATOR_DOCK_TEST_BEARER_TOKEN": token,
          "OPERATOR_DOCK_TEST_ENCRYPTION_KEY_BASE64": encryptionKey,
          "OPERATOR_DOCK_TEST_HMAC_KEY_BASE64": hmacKey,
          "OPERATOR_DOCK_STATE_ROOT": tempRoot.appendingPathComponent("state").path,
          "OPERATOR_DOCK_DB_PATH": tempRoot.appendingPathComponent("state/operator-dock.sqlite").path,
          "OPERATOR_DOCK_MIGRATIONS_DIR": root.appendingPathComponent("apps/daemon/migrations").path
        ],
        workingDirectory: root.path,
        respawnDelaySeconds: 0.1,
        watchdogIntervalSeconds: 0.2,
        healthTimeoutSeconds: 1.0,
        startupGraceSeconds: 2.0,
        healthFailureThreshold: 3,
        healthURLString: "http://127.0.0.1:\(port)/health",
        healthBearerToken: token,
        logFilePath: tempRoot.appendingPathComponent("daemon.log").path
      )
    )
    try supervisor.start()
    defer { supervisor.stop() }

    let client = DaemonClient(
      baseURL: URL(string: "http://127.0.0.1:\(port)")!,
      webSocketURL: URL(string: "ws://127.0.0.1:\(port)/v1/events")!,
      bearerToken: token
    )

    let initialHealth = await waitForHealth(client, timeout: 15)
    XCTAssertTrue(initialHealth, "Daemon did not become healthy before task creation.")
    guard initialHealth else {
      return
    }
    let task = try await client.createTask(
      title: "Supervision crash recovery",
      prompt: "Verify daemon state survives supervised SIGKILL and respawn."
    )
    let firstPID = try XCTUnwrap(supervisor.currentProcessIdentifier)

    try supervisor.killForCrashTest()

    let respawned = await waitUntil(timeout: 10) {
      guard let pid = supervisor.currentProcessIdentifier else {
        return false
      }

      return pid != firstPID
    }
    XCTAssertTrue(respawned)
    let recoveredHealth = await waitForHealth(client, timeout: 15)
    XCTAssertTrue(recoveredHealth, "Daemon did not become healthy after supervised crash recovery.")
    guard recoveredHealth else {
      return
    }

    let recoveredTasks = try await client.listTasks()
    XCTAssertTrue(recoveredTasks.contains { $0.id == task.id })
  }

  func testMacAppSupervisorRecoversFromDetachedExternalKill() async throws {
    let root = repositoryRoot()
    let daemonEntry = root.appendingPathComponent("apps/daemon/dist/index.js")
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: daemonEntry.path),
      "Run npm run build before this integration test."
    )

    let tempRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-supervision-detached-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempRoot) }

    let port = Int.random(in: 48_000...62_000)
    let token = "supervision-detached-token-\(UUID().uuidString)"
    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/usr/bin/env",
        arguments: ["node", daemonEntry.path],
        environment: [
          "HOME": tempRoot.path,
          "OPERATOR_DOCK_HOST": "127.0.0.1",
          "OPERATOR_DOCK_PORT": "\(port)",
          "OPERATOR_DOCK_TEST_MODE": "1",
          "OPERATOR_DOCK_TEST_BEARER_TOKEN": token,
          "OPERATOR_DOCK_TEST_ENCRYPTION_KEY_BASE64": Data(repeating: 0x43, count: 32).base64EncodedString(),
          "OPERATOR_DOCK_TEST_HMAC_KEY_BASE64": Data(repeating: 0x25, count: 32).base64EncodedString(),
          "OPERATOR_DOCK_STATE_ROOT": tempRoot.appendingPathComponent("state").path,
          "OPERATOR_DOCK_DB_PATH": tempRoot.appendingPathComponent("state/operator-dock.sqlite").path,
          "OPERATOR_DOCK_MIGRATIONS_DIR": root.appendingPathComponent("apps/daemon/migrations").path
        ],
        workingDirectory: root.path,
        respawnDelaySeconds: 0.1,
        watchdogIntervalSeconds: 0.2,
        healthTimeoutSeconds: 1.0,
        startupGraceSeconds: 2.0,
        healthFailureThreshold: 3,
        healthURLString: "http://127.0.0.1:\(port)/health",
        healthBearerToken: token,
        logFilePath: tempRoot.appendingPathComponent("daemon.log").path
      )
    )
    try supervisor.start()
    defer { supervisor.stop() }

    let client = DaemonClient(
      baseURL: URL(string: "http://127.0.0.1:\(port)")!,
      webSocketURL: URL(string: "ws://127.0.0.1:\(port)/v1/events")!,
      bearerToken: token
    )

    let initialHealth = await waitForHealth(client, timeout: 15)
    XCTAssertTrue(initialHealth, "Daemon did not become healthy before detached kill test.")
    guard initialHealth else {
      return
    }
    let task = try await client.createTask(
      title: "Detached crash recovery",
      prompt: "Verify watchdog recovers after a separate process kills the daemon."
    )
    let firstPID = try XCTUnwrap(supervisor.currentProcessIdentifier)

    let killer = Process()
    killer.executableURL = URL(fileURLWithPath: "/bin/kill")
    killer.arguments = ["-9", "\(firstPID)"]
    try killer.run()
    killer.waitUntilExit()
    XCTAssertEqual(killer.terminationStatus, 0)

    let respawned = await waitUntil(timeout: 10) {
      guard let pid = supervisor.currentProcessIdentifier else {
        return false
      }

      return pid != firstPID
    }
    XCTAssertTrue(respawned)
    let recoveredHealth = await waitForHealth(client, timeout: 15)
    XCTAssertTrue(recoveredHealth, "Daemon did not become healthy after detached kill recovery.")
    guard recoveredHealth else {
      return
    }

    let recoveredTasks = try await client.listTasks()
    XCTAssertTrue(recoveredTasks.contains { $0.id == task.id })
  }

  private func waitForHealth(_ client: DaemonClient, timeout: TimeInterval = 5) async -> Bool {
    await waitUntil(timeout: timeout) {
      (try? await client.health()) != nil
    }
  }

  private func waitUntil(timeout: TimeInterval, predicate: @escaping () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if await predicate() {
        return true
      }

      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    return false
  }

  private func repositoryRoot() -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }
}

private final class SupervisorNotificationRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private(set) var launchDates: [Date] = []
  private(set) var fatalMessage: String?

  func recordLaunch() {
    lock.withLock {
      launchDates.append(Date())
    }
  }

  func recordFatal(_ message: String?) {
    lock.withLock {
      fatalMessage = message ?? "fatal"
    }
  }

  func launchIntervals() -> [TimeInterval] {
    lock.withLock {
      guard launchDates.count >= 2 else {
        return []
      }

      return zip(launchDates.dropFirst(), launchDates).map { later, earlier in
        later.timeIntervalSince(earlier)
      }
    }
  }
}
