import Foundation

public enum DaemonSupervisorError: LocalizedError, Equatable {
  case daemonConfigurationMissing
  case daemonAlreadyRunning
  case daemonNotRunning

  public var errorDescription: String? {
    switch self {
    case .daemonConfigurationMissing:
      "Daemon supervisor configuration is missing."
    case .daemonAlreadyRunning:
      "Daemon supervisor already has a running daemon process."
    case .daemonNotRunning:
      "Daemon supervisor does not have a running daemon process."
    }
  }
}

public enum DaemonSupervisorNotificationKey {
  public static let pid = "pid"
  public static let message = "message"
  public static let logFilePath = "logFilePath"
  public static let restartFailureCount = "restartFailureCount"
}

public extension Notification.Name {
  static let daemonSupervisorDidLaunch = Notification.Name("OperatorDockDaemonSupervisorDidLaunch")
  static let daemonSupervisorFatalError = Notification.Name("OperatorDockDaemonSupervisorFatalError")
}

public final class DaemonSupervisor: @unchecked Sendable {
  public struct Configuration: Sendable, Codable, Equatable {
    public var executablePath: String
    public var arguments: [String]
    public var environment: [String: String]
    public var workingDirectory: String?
    public var respawnDelaySeconds: TimeInterval
    public var maxRespawnDelaySeconds: TimeInterval
    public var watchdogIntervalSeconds: TimeInterval
    public var healthTimeoutSeconds: TimeInterval
    public var startupGraceSeconds: TimeInterval
    public var healthFailureThreshold: Int
    public var maxRestartFailures: Int
    public var restartFailureWindowSeconds: TimeInterval
    public var healthURLString: String?
    public var healthBearerToken: String?
    public var logFilePath: String
    public var logRotationBytes: UInt64
    public var logRotationCount: Int

    public init(
      executablePath: String,
      arguments: [String] = [],
      environment: [String: String] = [:],
      workingDirectory: String? = nil,
      respawnDelaySeconds: TimeInterval = 1.0,
      maxRespawnDelaySeconds: TimeInterval = 30.0,
      watchdogIntervalSeconds: TimeInterval = 2.0,
      healthTimeoutSeconds: TimeInterval = 1.0,
      startupGraceSeconds: TimeInterval = 60.0,
      healthFailureThreshold: Int = 5,
      maxRestartFailures: Int = 10,
      restartFailureWindowSeconds: TimeInterval = 300.0,
      healthURLString: String? = nil,
      healthBearerToken: String? = nil,
      logFilePath: String = DaemonSupervisor.defaultLogFilePath,
      logRotationBytes: UInt64 = 10 * 1024 * 1024,
      logRotationCount: Int = 5
    ) {
      self.executablePath = executablePath
      self.arguments = arguments
      self.environment = environment
      self.workingDirectory = workingDirectory
      self.respawnDelaySeconds = max(0.01, respawnDelaySeconds)
      self.maxRespawnDelaySeconds = max(self.respawnDelaySeconds, maxRespawnDelaySeconds)
      self.watchdogIntervalSeconds = watchdogIntervalSeconds
      self.healthTimeoutSeconds = healthTimeoutSeconds
      self.startupGraceSeconds = startupGraceSeconds
      self.healthFailureThreshold = max(1, healthFailureThreshold)
      self.maxRestartFailures = max(1, maxRestartFailures)
      self.restartFailureWindowSeconds = max(1, restartFailureWindowSeconds)
      self.healthURLString = healthURLString
      self.healthBearerToken = healthBearerToken
      self.logFilePath = logFilePath
      self.logRotationBytes = max(1, logRotationBytes)
      self.logRotationCount = max(1, logRotationCount)
    }

    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Configuration? {
      guard let executablePath = environment["OPERATOR_DOCK_DAEMON_EXECUTABLE"], !executablePath.isEmpty else {
        return nil
      }

      let arguments = environment["OPERATOR_DOCK_DAEMON_ARGUMENTS"]
        .map(parseArguments(_:))
        ?? []
      let daemonEnvironment = environment
        .filter { key, _ in key.hasPrefix("OPERATOR_DOCK_") || key == "HOME" || key == "PATH" || key == "NODE_ENV" }

      return Configuration(
        executablePath: executablePath,
        arguments: arguments,
        environment: daemonEnvironment,
        workingDirectory: environment["OPERATOR_DOCK_DAEMON_WORKING_DIRECTORY"],
        healthURLString: environment["OPERATOR_DOCK_DAEMON_HEALTH_URL"],
        healthBearerToken: environment["OPERATOR_DOCK_DAEMON_HEALTH_BEARER_TOKEN"]
      )
    }

    public static func fromBundle(_ bundle: Bundle = .main) -> Configuration? {
      guard let url = bundle.url(forResource: "operator-dock-daemon", withExtension: "json"),
            let data = try? Data(contentsOf: url) else {
        return nil
      }

      return try? JSONDecoder().decode(Configuration.self, from: data)
    }
  }

  private let configuration: Configuration
  private let authTokenStore: DaemonAuthTokenStore
  private let lock = NSLock()
  private var process: Process?
  private var watchdog: DispatchSourceTimer?
  private var watchdogCheckInFlight = false
  private var processStartedAt: Date?
  private var consecutiveHealthFailures = 0
  private var stoppedIntentionally = false
  private var stdoutPipe: Pipe?
  private var stderrPipe: Pipe?
  private var logWriter: DaemonLogWriter?
  private var currentRespawnDelaySeconds: TimeInterval
  private var restartFailureCount = 0
  private var restartFailureWindowStartedAt: Date?
  private var respawnScheduled = false
  private var fatalErrorMessage: String?

  public init(configuration: Configuration, authTokenStore: DaemonAuthTokenStore = DaemonAuthTokenStore()) {
    self.configuration = configuration
    self.authTokenStore = authTokenStore
    self.currentRespawnDelaySeconds = configuration.respawnDelaySeconds
  }

  public static func live() -> DaemonSupervisor? {
    if let configuration = Configuration.fromBundle() ?? Configuration.fromEnvironment() {
      return DaemonSupervisor(configuration: configuration)
    }

    return nil
  }

  public static var defaultLogFilePath: String {
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library", isDirectory: true)
    return library
      .appendingPathComponent("Logs", isDirectory: true)
      .appendingPathComponent("OperatorDock", isDirectory: true)
      .appendingPathComponent("daemon.log")
      .path
  }

  public var logFilePath: String {
    configuration.logFilePath
  }

  public var currentProcessIdentifier: Int32? {
    lock.withLock {
      guard let process, process.isRunning else {
        return nil
      }

      return process.processIdentifier
    }
  }

  public func start() throws {
    lock.lock()
    defer { lock.unlock() }

    if process?.isRunning == true {
      throw DaemonSupervisorError.daemonAlreadyRunning
    }

    stoppedIntentionally = false
    fatalErrorMessage = nil
    respawnScheduled = false
    resetRestartFailuresLocked()
    try startLocked()
    startWatchdogLocked()
  }

  public func stop() {
    let running: Process? = lock.withLock {
      stoppedIntentionally = true
      watchdog?.cancel()
      watchdog = nil
      let current = process
      process = nil
      respawnScheduled = false
      return current
    }

    guard let running, running.isRunning else {
      return
    }

    running.terminate()
  }

  public func killForCrashTest() throws {
    let pid = lock.withLock { process?.isRunning == true ? process?.processIdentifier : nil }
    guard let pid else {
      throw DaemonSupervisorError.daemonNotRunning
    }

    Darwin.kill(pid, SIGKILL)
  }

  private func startLocked() throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: configuration.executablePath)
    process.arguments = configuration.arguments
    process.environment = mergedEnvironment(configuration.environment)
    if let workingDirectory = configuration.workingDirectory {
      process.currentDirectoryURL = URL(fileURLWithPath: workingDirectory)
    }

    let writer = try DaemonLogWriter(
      path: configuration.logFilePath,
      rotationBytes: configuration.logRotationBytes,
      rotationCount: configuration.logRotationCount
    )
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    stdoutPipe.fileHandleForReading.readabilityHandler = { [writer] handle in
      writer.write(handle.availableData)
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { [writer] handle in
      writer.write(handle.availableData)
    }
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    process.terminationHandler = { [weak self] terminatedProcess in
      stdoutPipe.fileHandleForReading.readabilityHandler = nil
      stderrPipe.fileHandleForReading.readabilityHandler = nil
      writer.close()
      self?.handleTermination(of: terminatedProcess)
    }

    do {
      try process.run()
    } catch {
      stdoutPipe.fileHandleForReading.readabilityHandler = nil
      stderrPipe.fileHandleForReading.readabilityHandler = nil
      writer.close()
      throw error
    }
    self.process = process
    self.processStartedAt = Date()
    self.consecutiveHealthFailures = 0
    self.stdoutPipe = stdoutPipe
    self.stderrPipe = stderrPipe
    self.logWriter = writer
    NotificationCenter.default.post(
      name: .daemonSupervisorDidLaunch,
      object: self,
      userInfo: [
        DaemonSupervisorNotificationKey.pid: Int(process.processIdentifier)
      ]
    )
  }

  private func handleTermination(of terminatedProcess: Process) {
    let action = lock.withLock { () -> SupervisorRestartAction in
      guard process === terminatedProcess else {
        return .none
      }

      process = nil
      stdoutPipe = nil
      stderrPipe = nil
      logWriter = nil

      guard !stoppedIntentionally else {
        return .none
      }

      if terminatedProcess.terminationReason == .exit && terminatedProcess.terminationStatus == 0 {
        return .none
      }

      return recordRestartFailureLocked(reason: "Daemon process exited before it became healthy.")
    }

    performRestartAction(action)
  }

  private func respawnIfNeeded(fromScheduledTimer: Bool = false) {
    lock.lock()
    guard !stoppedIntentionally, fatalErrorMessage == nil, process?.isRunning != true else {
      lock.unlock()
      return
    }

    if respawnScheduled && !fromScheduledTimer {
      lock.unlock()
      return
    }

    respawnScheduled = false
    do {
      try startLocked()
      lock.unlock()
    } catch {
      let action = recordRestartFailureLocked(reason: "Daemon process failed to launch: \(error.localizedDescription)")
      lock.unlock()
      performRestartAction(action)
    }
  }

  private func startWatchdogLocked() {
    guard watchdog == nil else {
      return
    }

    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(
      deadline: .now() + configuration.watchdogIntervalSeconds,
      repeating: configuration.watchdogIntervalSeconds
    )
    timer.setEventHandler { [weak self] in
      self?.watchdogTick()
    }
    watchdog = timer
    timer.resume()
  }

  private func watchdogTick() {
    let snapshot = lock.withLock { () -> (pid: Int32?, isRunning: Bool, healthURL: URL?, token: String?, startedAt: Date?) in
      guard !stoppedIntentionally else {
        return (nil, false, nil, nil, nil)
      }

      guard let process else {
        return (nil, false, nil, nil, nil)
      }

      let token = configuration.healthBearerToken ?? authTokenStore.loadOrCreateTokenIgnoringErrors()
      return (
        process.processIdentifier,
        process.isRunning,
        healthURL(),
        token,
        processStartedAt
      )
    }

    guard let pid = snapshot.pid else {
      respawnIfNeeded()
      return
    }

    if !snapshot.isRunning || !processExists(pid) {
      markProcessUnhealthyAndRespawn(pid: pid)
      return
    }

    guard let healthURL = snapshot.healthURL else {
      return
    }

    let inGracePeriod = snapshot.startedAt.map {
      Date().timeIntervalSince($0) < configuration.startupGraceSeconds
    } ?? false
    if inGracePeriod {
      return
    }

    let shouldStartHealthCheck = lock.withLock { () -> Bool in
      guard !watchdogCheckInFlight else {
        return false
      }
      watchdogCheckInFlight = true
      return true
    }

    guard shouldStartHealthCheck else {
      return
    }

    Task.detached { [weak self] in
      let healthy = await self?.checkHealth(url: healthURL, bearerToken: snapshot.token) ?? false
      self?.finishHealthCheck(pid: pid, healthy: healthy)
    }
  }

  private func finishHealthCheck(pid: Int32, healthy: Bool) {
    let shouldRespawn = lock.withLock { () -> Bool in
      watchdogCheckInFlight = false
      guard !stoppedIntentionally, process?.processIdentifier == pid else {
        return false
      }

      if healthy {
        consecutiveHealthFailures = 0
        resetRestartFailuresLocked()
        return false
      }

      consecutiveHealthFailures += 1
      return consecutiveHealthFailures >= configuration.healthFailureThreshold
    }

    if shouldRespawn {
      markProcessUnhealthyAndRespawn(pid: pid)
    }
  }

  private func markProcessUnhealthyAndRespawn(pid: Int32) {
    let result = lock.withLock { () -> (process: Process?, action: SupervisorRestartAction) in
      guard !stoppedIntentionally, process?.processIdentifier == pid else {
        return (nil, .none)
      }

      let current = process
      process = nil
      consecutiveHealthFailures = 0
      let action = recordRestartFailureLocked(reason: "Daemon failed health checks before becoming ready.")
      return (current, action)
    }

    guard result.process != nil else {
      return
    }

    if processExists(pid) {
      Darwin.kill(pid, SIGKILL)
    }
    performRestartAction(result.action)
  }

  private func recordRestartFailureLocked(reason: String) -> SupervisorRestartAction {
    let now = Date()
    if let windowStartedAt = restartFailureWindowStartedAt,
       now.timeIntervalSince(windowStartedAt) <= configuration.restartFailureWindowSeconds {
      restartFailureCount += 1
    } else {
      restartFailureWindowStartedAt = now
      restartFailureCount = 1
      currentRespawnDelaySeconds = configuration.respawnDelaySeconds
    }

    if restartFailureCount >= configuration.maxRestartFailures {
      let message = "Daemon failed to start. Logs: \(configuration.logFilePath)"
      fatalErrorMessage = message
      stoppedIntentionally = true
      respawnScheduled = false
      return .fatal(
        message: message,
        logFilePath: configuration.logFilePath,
        restartFailureCount: restartFailureCount
      )
    }

    let delay = currentRespawnDelaySeconds
    currentRespawnDelaySeconds = min(
      configuration.maxRespawnDelaySeconds,
      max(configuration.respawnDelaySeconds, currentRespawnDelaySeconds * 2)
    )
    return .schedule(delay: delay, reason: reason)
  }

  private func resetRestartFailuresLocked() {
    restartFailureCount = 0
    restartFailureWindowStartedAt = nil
    currentRespawnDelaySeconds = configuration.respawnDelaySeconds
  }

  private func performRestartAction(_ action: SupervisorRestartAction) {
    switch action {
    case .none:
      return
    case .schedule(let delay, _):
      lock.withLock {
        guard !stoppedIntentionally, fatalErrorMessage == nil else {
          return
        }
        respawnScheduled = true
      }
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [weak self] in
        self?.respawnIfNeeded(fromScheduledTimer: true)
      }
    case .fatal(let message, let logFilePath, let restartFailureCount):
      NotificationCenter.default.post(
        name: .daemonSupervisorFatalError,
        object: self,
        userInfo: [
          DaemonSupervisorNotificationKey.message: message,
          DaemonSupervisorNotificationKey.logFilePath: logFilePath,
          DaemonSupervisorNotificationKey.restartFailureCount: restartFailureCount
        ]
      )
    }
  }

  private func healthURL() -> URL? {
    if let healthURLString = configuration.healthURLString {
      return URL(string: healthURLString)
    }

    let host = configuration.environment["OPERATOR_DOCK_HOST"] ?? "127.0.0.1"
    let port = configuration.environment["OPERATOR_DOCK_PORT"] ?? "4768"
    return URL(string: "http://\(host):\(port)/health")
  }

  private func checkHealth(url: URL, bearerToken: String?) async -> Bool {
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = configuration.healthTimeoutSeconds
    if let bearerToken, !bearerToken.isEmpty {
      request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "authorization")
    }

    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }
}

private func mergedEnvironment(_ overrides: [String: String]) -> [String: String] {
  var environment = ProcessInfo.processInfo.environment
  for (key, value) in overrides {
    environment[key] = value
  }
  return environment
}

private func parseArguments(_ value: String) -> [String] {
  (try? JSONDecoder().decode([String].self, from: Data(value.utf8))) ?? []
}

private func processExists(_ pid: Int32) -> Bool {
  errno = 0
  return Darwin.kill(pid, 0) == 0 || errno == EPERM
}

private enum SupervisorRestartAction {
  case none
  case schedule(delay: TimeInterval, reason: String)
  case fatal(message: String, logFilePath: String, restartFailureCount: Int)
}

private final class DaemonLogWriter: @unchecked Sendable {
  private let path: String
  private let rotationBytes: UInt64
  private let rotationCount: Int
  private let lock = NSLock()
  private var handle: FileHandle?
  private var currentSize: UInt64 = 0

  init(path: String, rotationBytes: UInt64, rotationCount: Int) throws {
    self.path = path
    self.rotationBytes = rotationBytes
    self.rotationCount = rotationCount
    try open()
  }

  func write(_ data: Data) {
    guard !data.isEmpty else {
      return
    }

    lock.lock()
    defer { lock.unlock() }

    do {
      if currentSize + UInt64(data.count) > rotationBytes {
        try rotateLocked()
      }

      if handle == nil {
        try openLocked()
      }

      handle?.write(data)
      currentSize += UInt64(data.count)
    } catch {
      // Logging must never take down the supervised daemon.
    }
  }

  func close() {
    lock.lock()
    defer { lock.unlock() }

    try? handle?.synchronize()
    try? handle?.close()
    handle = nil
  }

  private func open() throws {
    lock.lock()
    defer { lock.unlock() }

    try openLocked()
    if currentSize > rotationBytes {
      try rotateLocked()
    }
  }

  private func openLocked() throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    if !FileManager.default.fileExists(atPath: path) {
      _ = FileManager.default.createFile(atPath: path, contents: nil)
    }

    handle = try FileHandle(forWritingTo: url)
    currentSize = try handle?.seekToEnd() ?? 0
  }

  private func rotateLocked() throws {
    try? handle?.synchronize()
    try? handle?.close()
    handle = nil

    let fileManager = FileManager.default
    if rotationCount > 0 {
      let oldest = "\(path).\(rotationCount)"
      if fileManager.fileExists(atPath: oldest) {
        try? fileManager.removeItem(atPath: oldest)
      }

      if rotationCount >= 2 {
        for index in stride(from: rotationCount - 1, through: 1, by: -1) {
          let source = "\(path).\(index)"
          let destination = "\(path).\(index + 1)"
          if fileManager.fileExists(atPath: source) {
            try? fileManager.moveItem(atPath: source, toPath: destination)
          }
        }
      }

      if fileManager.fileExists(atPath: path) {
        try? fileManager.moveItem(atPath: path, toPath: "\(path).1")
      }
    } else if fileManager.fileExists(atPath: path) {
      try? fileManager.removeItem(atPath: path)
    }

    _ = FileManager.default.createFile(atPath: path, contents: nil)
    currentSize = 0
    handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
  }
}

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
