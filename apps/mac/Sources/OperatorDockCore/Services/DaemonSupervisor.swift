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

public final class DaemonSupervisor: @unchecked Sendable {
  public struct Configuration: Sendable, Codable, Equatable {
    public var executablePath: String
    public var arguments: [String]
    public var environment: [String: String]
    public var workingDirectory: String?
    public var respawnDelaySeconds: TimeInterval
    public var watchdogIntervalSeconds: TimeInterval
    public var healthTimeoutSeconds: TimeInterval
    public var startupGraceSeconds: TimeInterval
    public var healthFailureThreshold: Int
    public var healthURLString: String?
    public var healthBearerToken: String?

    public init(
      executablePath: String,
      arguments: [String] = [],
      environment: [String: String] = [:],
      workingDirectory: String? = nil,
      respawnDelaySeconds: TimeInterval = 0.5,
      watchdogIntervalSeconds: TimeInterval = 2.0,
      healthTimeoutSeconds: TimeInterval = 1.0,
      startupGraceSeconds: TimeInterval = 3.0,
      healthFailureThreshold: Int = 1,
      healthURLString: String? = nil,
      healthBearerToken: String? = nil
    ) {
      self.executablePath = executablePath
      self.arguments = arguments
      self.environment = environment
      self.workingDirectory = workingDirectory
      self.respawnDelaySeconds = respawnDelaySeconds
      self.watchdogIntervalSeconds = watchdogIntervalSeconds
      self.healthTimeoutSeconds = healthTimeoutSeconds
      self.startupGraceSeconds = startupGraceSeconds
      self.healthFailureThreshold = max(1, healthFailureThreshold)
      self.healthURLString = healthURLString
      self.healthBearerToken = healthBearerToken
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

  public init(configuration: Configuration, authTokenStore: DaemonAuthTokenStore = DaemonAuthTokenStore()) {
    self.configuration = configuration
    self.authTokenStore = authTokenStore
  }

  public static func live() -> DaemonSupervisor? {
    if let configuration = Configuration.fromBundle() ?? Configuration.fromEnvironment() {
      return DaemonSupervisor(configuration: configuration)
    }

    return nil
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

    if let null = FileHandle(forWritingAtPath: "/dev/null") {
      process.standardOutput = null
      process.standardError = null
    }

    process.terminationHandler = { [weak self] terminatedProcess in
      self?.handleTermination(of: terminatedProcess)
    }

    try process.run()
    self.process = process
    self.processStartedAt = Date()
    self.consecutiveHealthFailures = 0
  }

  private func handleTermination(of terminatedProcess: Process) {
    let shouldRespawn = lock.withLock { () -> Bool in
      guard process === terminatedProcess else {
        return false
      }

      process = nil
      return !stoppedIntentionally && terminatedProcess.terminationReason != .exit
    }

    guard shouldRespawn else {
      return
    }

    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + configuration.respawnDelaySeconds) { [weak self] in
      self?.respawnIfNeeded()
    }
  }

  private func respawnIfNeeded() {
    lock.lock()
    defer { lock.unlock() }

    guard !stoppedIntentionally, process?.isRunning != true else {
      return
    }

    try? startLocked()
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
    let staleProcess = lock.withLock { () -> Process? in
      guard !stoppedIntentionally, process?.processIdentifier == pid else {
        return nil
      }

      let current = process
      process = nil
      consecutiveHealthFailures = 0
      return current
    }

    guard staleProcess != nil else {
      return
    }

    if processExists(pid) {
      Darwin.kill(pid, SIGKILL)
    }
    respawnIfNeeded()
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

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
