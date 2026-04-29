import Foundation

public struct LaunchdConfiguration: Equatable, Sendable {
  public let schemaVersion: Int
  public let label: String
  public let executablePath: String
  public let machServiceName: String

  public init(
    schemaVersion: Int = 1,
    label: String,
    executablePath: String,
    machServiceName: String
  ) {
    self.schemaVersion = schemaVersion
    self.label = label
    self.executablePath = executablePath
    self.machServiceName = machServiceName
  }
}

public struct LaunchdPlistRenderer: Sendable {
  public let configuration: LaunchdConfiguration

  public init(configuration: LaunchdConfiguration) {
    self.configuration = configuration
  }

  public func data() throws -> Data {
    let plist: [String: Any] = [
      "Label": configuration.label,
      "ProgramArguments": [configuration.executablePath],
      "MachServices": [
        configuration.machServiceName: true
      ],
      "RunAtLoad": true,
      "KeepAlive": true,
      "EnvironmentVariables": [
        "schemaVersion": "\(configuration.schemaVersion)"
      ],
      "StandardOutPath": "\(NSHomeDirectory())/Library/Logs/OperatorDock/helper.out.log",
      "StandardErrorPath": "\(NSHomeDirectory())/Library/Logs/OperatorDock/helper.err.log"
    ]

    return try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
  }
}

public struct LaunchdManager: Sendable {
  public let launchAgentsDirectory: URL

  public init(launchAgentsDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents", isDirectory: true)) {
    self.launchAgentsDirectory = launchAgentsDirectory
  }

  public func writePlist(configuration: LaunchdConfiguration) throws -> URL {
    try FileManager.default.createDirectory(at: launchAgentsDirectory, withIntermediateDirectories: true)
    let url = launchAgentsDirectory.appendingPathComponent("\(configuration.label).plist")
    try LaunchdPlistRenderer(configuration: configuration).data().write(to: url, options: .atomic)
    return url
  }
}
