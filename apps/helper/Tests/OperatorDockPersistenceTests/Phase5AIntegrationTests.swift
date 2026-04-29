import Foundation
import XCTest
@testable import OperatorDockPersistence

final class Phase5AIntegrationTests: XCTestCase {
  func testFullLifecycleSmokeReconstructsByteIdenticalStateAfterRestart() throws {
    let harness = try IntegrationHarness()
    let taskId = "task-full-lifecycle"
    _ = try harness.tasks.createTask(taskId: taskId)

    var representedEventIds: [String] = []
    for index in 0..<25 {
      representedEventIds.append(try harness.appendStep(taskId: taskId, index: index))
    }
    _ = try harness.tasks.transition(taskId: taskId, to: .paused)
    for index in 25..<50 {
      representedEventIds.append(try harness.appendStep(taskId: taskId, index: index))
    }
    _ = try harness.tasks.transition(taskId: taskId, to: .completed)

    for representedEventId in [representedEventIds[9], representedEventIds[24], representedEventIds[49]] {
      let derivedState = try lifecycleStateReducer(
        nil,
        harness.eventStore.readAll(taskId: taskId)
          .prefixThrough(eventId: representedEventId)
      )
      try harness.checkpoints.writeCheckpoint(
        taskId: taskId,
        eventId: representedEventId,
        derivedState: derivedState
      )
      _ = try harness.tasks.recordCheckpoint(taskId: taskId, checkpointEventId: representedEventId)
    }

    let expected = try harness.recovery.recover(taskId: taskId, reducer: lifecycleStateReducer)
    let restarted = try harness.restarted()

    try restarted.eventStore.verify(taskId: taskId)
    let actual = try restarted.recovery.recover(taskId: taskId, reducer: lifecycleStateReducer)
    XCTAssertEqual(actual, expected)
    XCTAssertEqual(try restarted.tasks.loadTask(taskId: taskId)?.state, .completed)
  }

  func testMultiTaskIsolationMaintainsIndependentChains() throws {
    let harness = try IntegrationHarness()
    let taskIds = (0..<10).map { "task-isolated-\($0)" }

    for round in 0..<12 {
      for taskId in taskIds {
        _ = try harness.appendStep(taskId: taskId, index: round)
      }
    }

    for taskId in taskIds {
      try harness.eventStore.verify(taskId: taskId)
      let events = try harness.eventStore.readAll(taskId: taskId)
      XCTAssertEqual(events.count, 12)
      XCTAssertTrue(events.allSatisfy { $0.taskId == taskId })
    }
  }

  func testScaledSoakMaintainsIntegrityHeartbeatsAndNoLeakedLocks() throws {
    let harness = try IntegrationHarness()
    let taskId = "task-scaled-soak"
    let lock = try harness.lockController.acquire(taskId: taskId)
    let eventCount = ProcessInfo.processInfo.environment["OPERATOR_DOCK_FULL_SOAK"] == "1" ? 1_000 : 150

    for index in 0..<eventCount {
      _ = try harness.appendStep(taskId: taskId, index: index)
      if index % 50 == 0 {
        try harness.lockController.heartbeat(lock)
      }
    }
    try harness.lockController.release(lock)

    try harness.eventStore.verify(taskId: taskId)
    let eventTypes = try harness.eventStore.readAll(taskId: taskId).map(\.eventType)
    XCTAssertTrue(eventTypes.contains("daemon_heartbeat"))
    XCTAssertTrue(eventTypes.contains("lock_released"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.paths.locks.appendingPathComponent("\(taskId).lock").path))
  }

  func testKeysNotReadableBeforeFirstUnlockFailsClosedWithMockHarness() {
    let keychain = MockKeychainClient()
    keychain.failReads = true
    let manager = PersistenceKeyManager(keychain: keychain)

    XCTAssertThrowsError(try manager.loadOrCreateKeys()) { error in
      XCTAssertEqual(error as? PersistenceSecurityError, .keychainUnavailable)
    }
  }

  func testNoSecretsInLogsAuditDetectsCleanRun() throws {
    let logs = try temporaryDirectory()
    let logFile = logs.appendingPathComponent("helper.log")
    try Data("daemon_started without sensitive material\n".utf8).write(to: logFile)
    let secrets = [
      Data(repeating: 0xA7, count: 32),
      Data(repeating: 0xB8, count: 32)
    ]

    try SecretLogAuditor(logDirectory: logs).assertNoSecrets(secrets)
  }

  func testRealKeychainKeysGeneratedOnFirstLaunchWhenEnabled() throws {
    guard ProcessInfo.processInfo.environment["OPERATOR_DOCK_RUN_REAL_KEYCHAIN_TESTS"] == "1" else {
      throw XCTSkip("blocked: set OPERATOR_DOCK_RUN_REAL_KEYCHAIN_TESTS=1 on a macOS runner with an unlocked login Keychain")
    }

    let keys = try PersistenceKeyManager(keychain: SecurityKeychainClient()).loadOrCreateKeys()

    XCTAssertEqual(keys.encryptionKeyBytes.count, 32)
    XCTAssertEqual(keys.hmacKeyBytes.count, 32)
  }

  func testSignedClientAcceptedWhenSigningInfrastructureConfigured() throws {
    guard ProcessInfo.processInfo.environment["OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS"] == "1" else {
      throw XCTSkip("blocked: set OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS=1 and provide OPERATOR_DOCK_SIGNED_CLIENT_AUDIT_TOKEN_BASE64")
    }
    guard let encodedToken = ProcessInfo.processInfo.environment["OPERATOR_DOCK_SIGNED_CLIENT_AUDIT_TOKEN_BASE64"],
          let auditToken = Data(base64Encoded: encodedToken) else {
      XCTFail("OPERATOR_DOCK_SIGNED_CLIENT_AUDIT_TOKEN_BASE64 is required for signed-binary validation")
      return
    }

    let harness = try IntegrationHarness()
    let gate = XPCSecurityGate(eventStore: harness.eventStore, validator: SecCodeClientValidator())

    let result = try gate.establishConnection(XPCConnectionRequest(clientIdentifier: "signed-client", auditToken: auditToken))

    guard case .accepted = result else {
      XCTFail("Signed client should be accepted when signing infrastructure is configured")
      return
    }
  }

  func testUnsignedClientRejectedWhenSigningInfrastructureConfigured() throws {
    guard ProcessInfo.processInfo.environment["OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS"] == "1" else {
      throw XCTSkip("blocked: set OPERATOR_DOCK_RUN_SIGNED_BINARY_TESTS=1 and provide OPERATOR_DOCK_UNSIGNED_CLIENT_AUDIT_TOKEN_BASE64")
    }
    guard let encodedToken = ProcessInfo.processInfo.environment["OPERATOR_DOCK_UNSIGNED_CLIENT_AUDIT_TOKEN_BASE64"],
          let auditToken = Data(base64Encoded: encodedToken) else {
      XCTFail("OPERATOR_DOCK_UNSIGNED_CLIENT_AUDIT_TOKEN_BASE64 is required for unsigned-client validation")
      return
    }

    let harness = try IntegrationHarness()
    let gate = XPCSecurityGate(eventStore: harness.eventStore, validator: SecCodeClientValidator())

    let result = try gate.establishConnection(XPCConnectionRequest(clientIdentifier: "unsigned-client", auditToken: auditToken))

    guard case .rejected = result else {
      XCTFail("Unsigned client should be rejected when signing infrastructure is configured")
      return
    }
  }

  func testDaemonStartsViaLaunchdWhenEnabled() throws {
    guard ProcessInfo.processInfo.environment["OPERATOR_DOCK_RUN_LAUNCHD_TESTS"] == "1" else {
      throw XCTSkip("blocked: set OPERATOR_DOCK_RUN_LAUNCHD_TESTS=1 and OPERATOR_DOCK_HELPER_EXECUTABLE_PATH on a macOS host")
    }
    guard let executablePath = ProcessInfo.processInfo.environment["OPERATOR_DOCK_HELPER_EXECUTABLE_PATH"] else {
      XCTFail("OPERATOR_DOCK_HELPER_EXECUTABLE_PATH is required for launchd integration")
      return
    }

    let label = "com.perlantir.operatordock.integration.\(UUID().uuidString)"
    let launchAgents = try temporaryDirectory()
    let plist = try LaunchdManager(launchAgentsDirectory: launchAgents).writePlist(
      configuration: LaunchdConfiguration(
        label: label,
        executablePath: executablePath,
        machServiceName: "\(label).xpc"
      )
    )
    defer {
      _ = runLaunchctl(["bootout", "gui/\(getuid())", plist.path])
    }

    let bootstrap = runLaunchctl(["bootstrap", "gui/\(getuid())", plist.path])
    XCTAssertEqual(bootstrap.terminationStatus, 0, bootstrap.output)
  }

  func testDaemonRelaunchesAfterCrashWhenEnabled() throws {
    guard ProcessInfo.processInfo.environment["OPERATOR_DOCK_RUN_LAUNCHD_CRASH_TESTS"] == "1" else {
      throw XCTSkip("blocked: set OPERATOR_DOCK_RUN_LAUNCHD_CRASH_TESTS=1 with a signed long-running helper fixture")
    }
    guard let executablePath = ProcessInfo.processInfo.environment["OPERATOR_DOCK_LONG_RUNNING_HELPER_PATH"] else {
      throw XCTSkip("blocked: OPERATOR_DOCK_LONG_RUNNING_HELPER_PATH is required for crash-relaunch validation")
    }

    let label = "com.perlantir.operatordock.crash.\(UUID().uuidString)"
    let launchAgents = try temporaryDirectory()
    let plist = try LaunchdManager(launchAgentsDirectory: launchAgents).writePlist(
      configuration: LaunchdConfiguration(
        label: label,
        executablePath: executablePath,
        machServiceName: "\(label).xpc"
      )
    )
    defer {
      _ = runLaunchctl(["bootout", "gui/\(getuid())", plist.path])
    }

    let bootstrap = runLaunchctl(["bootstrap", "gui/\(getuid())", plist.path])
    XCTAssertEqual(bootstrap.terminationStatus, 0, bootstrap.output)
    Thread.sleep(forTimeInterval: 1)

    let firstPrint = runLaunchctl(["print", "gui/\(getuid())/\(label)"])
    let firstPid = try XCTUnwrap(parseLaunchdPID(firstPrint.output), firstPrint.output)
    XCTAssertEqual(kill(pid_t(firstPid), SIGKILL), 0)
    Thread.sleep(forTimeInterval: 2)

    let secondPrint = runLaunchctl(["print", "gui/\(getuid())/\(label)"])
    let secondPid = try XCTUnwrap(parseLaunchdPID(secondPrint.output), secondPrint.output)
    XCTAssertNotEqual(firstPid, secondPid)
  }
}

private final class IntegrationHarness {
  let paths: OperatorDockPaths
  let keys = PersistenceKeys(
    encryptionKeyBytes: Data(repeating: 0x63, count: 32),
    hmacKeyBytes: Data(repeating: 0x64, count: 32)
  )
  let eventStore: EventStore
  let checkpoints: CheckpointStore
  let recovery: CheckpointRecovery
  let tasks: TaskMetadataStore
  let lockController: LockController

  init(root: URL? = nil) throws {
    paths = try OperatorDockPaths(root: root ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("operator-dock-integration-\(UUID().uuidString)", isDirectory: true))
    try paths.createLayout()
    eventStore = EventStore(paths: paths, keys: keys)
    checkpoints = CheckpointStore(paths: paths, keys: keys, eventStore: eventStore)
    recovery = CheckpointRecovery(eventStore: eventStore, checkpoints: checkpoints)
    tasks = TaskMetadataStore(paths: paths, keys: keys, eventStore: eventStore)
    lockController = LockController(paths: paths, eventStore: eventStore, daemonInstanceId: "daemon-integration", pid: 606)
  }

  func restarted() throws -> IntegrationHarness {
    try IntegrationHarness(root: paths.root)
  }

  @discardableResult
  func appendStep(taskId: String, index: Int) throws -> String {
    try eventStore.append(
      taskId: taskId,
      eventType: "task_state_transition",
      payload: [
        "step": .number(Double(index)),
        "phase": .string("integration")
      ]
    )
  }
}

private func lifecycleStateReducer(_ checkpoint: Data?, _ events: [EventRecord]) throws -> Data {
  var lines = checkpoint.flatMap { String(data: $0, encoding: .utf8) }
    .map { $0.isEmpty ? [] : $0.components(separatedBy: "\n") } ?? []

  for event in events where event.eventType != "checkpoint_written" {
    lines.append("\(event.eventType):\(event.eventId)")
  }

  return Data(lines.joined(separator: "\n").utf8)
}

private extension Array where Element == EventRecord {
  func prefixThrough(eventId: String) -> [EventRecord] {
    guard let index = firstIndex(where: { $0.eventId == eventId }) else {
      return self
    }
    return Array(prefix(index + 1))
  }
}

private func runLaunchctl(_ arguments: [String]) -> (terminationStatus: Int32, output: String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
  process.arguments = arguments
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe

  do {
    try process.run()
    process.waitUntilExit()
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    return (process.terminationStatus, output)
  } catch {
    return (-1, error.localizedDescription)
  }
}

private func parseLaunchdPID(_ output: String) -> Int? {
  for line in output.components(separatedBy: .newlines) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("pid = ") else {
      continue
    }
    return Int(trimmed.replacingOccurrences(of: "pid = ", with: ""))
  }
  return nil
}
