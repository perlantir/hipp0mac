import Foundation
import XCTest
@testable import OperatorDockCore

final class DaemonSupervisorTests: XCTestCase {
  func testSupervisorRespawnsCrashedChildProcess() async throws {
    let supervisor = DaemonSupervisor(
      configuration: .init(
        executablePath: "/bin/sleep",
        arguments: ["60"],
        respawnDelaySeconds: 0.05
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

  func testMacAppSupervisorCrashRecoveryWithNodeDaemon() async throws {
    let root = repositoryRoot()
    let daemonEntry = root.appendingPathComponent("apps/daemon/dist/index.js")
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: daemonEntry.path),
      "Run npm run build -w @operator-dock/daemon before this integration test."
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
        healthTimeoutSeconds: 0.5,
        startupGraceSeconds: 0.2,
        healthFailureThreshold: 1,
        healthURLString: "http://127.0.0.1:\(port)/health",
        healthBearerToken: token
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
      "Run npm run build -w @operator-dock/daemon before this integration test."
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
        respawnDelaySeconds: 30,
        watchdogIntervalSeconds: 0.2,
        healthTimeoutSeconds: 0.5,
        startupGraceSeconds: 0.2,
        healthFailureThreshold: 1,
        healthURLString: "http://127.0.0.1:\(port)/health",
        healthBearerToken: token
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
