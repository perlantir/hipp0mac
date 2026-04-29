import Foundation
import Observation
import OperatorDockCore

enum ConnectionState: String {
  case disconnected = "Disconnected"
  case connecting = "Connecting"
  case connected = "Connected"
}

@MainActor
@Observable
final class AppStore {
  var selectedSection: SidebarSection = .home
  var connectionState: ConnectionState = .disconnected
  var health: HealthResponse?
  var tasks: [DockTask] = []
  var events: [OperatorEvent] = []
  var providers: [ProviderConfig] = []
  var routerConfig: ModelRouterConfig?
  var providerTestResults: [ProviderId: ProviderConnectionTestResponse] = [:]
  var workspace: WorkspaceSettings?
  var workspaceFiles: [FileEntry] = []
  var fileExplorerPath = "."
  var commandText = ""
  var isCreatingTestTask = false
  var isRefreshingProviders = false
  var lastError: String?

  var displayTasks: [OperatorTask] {
    let liveTasks = tasks.map(OperatorTask.init(task:))
    return liveTasks.isEmpty ? SampleData.tasks : liveTasks + SampleData.tasks
  }

  private let client: DaemonClient
  private let credentialStore: ProviderCredentialStore
  private var eventStreamTask: Swift.Task<Void, Never>?

  init(client: DaemonClient, credentialStore: ProviderCredentialStore = ProviderCredentialStore()) {
    self.client = client
    self.credentialStore = credentialStore
  }

  func start() {
    guard eventStreamTask == nil else {
      return
    }

    eventStreamTask = Swift.Task {
      await listenForEvents()
    }

    Swift.Task {
      await refreshHealth()
      await refreshTasks()
      await refreshProviders()
      await refreshWorkspace()
    }
  }

  func refreshHealth() async {
    do {
      health = try await client.health()
      lastError = nil
    } catch {
      connectionState = .disconnected
      lastError = error.localizedDescription
    }
  }

  func refreshTasks() async {
    do {
      tasks = try await client.listTasks()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func refreshProviders() async {
    guard !isRefreshingProviders else {
      return
    }

    isRefreshingProviders = true
    defer {
      isRefreshingProviders = false
    }

    do {
      async let providerList = client.listProviders()
      async let router = client.modelRouterConfig()
      providers = try await providerList
      routerConfig = try await router
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func refreshWorkspace() async {
    do {
      workspace = try await client.workspace()
      workspaceFiles = try await client.listWorkspaceFiles(path: fileExplorerPath)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func configureWorkspace(rootPath: String) async {
    do {
      workspace = try await client.configureWorkspace(rootPath: rootPath)
      fileExplorerPath = "."
      workspaceFiles = try await client.listWorkspaceFiles(path: fileExplorerPath)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func openFileExplorerFolder(_ entry: FileEntry) async {
    guard entry.kind == .directory else {
      return
    }

    fileExplorerPath = entry.relativePath
    do {
      workspaceFiles = try await client.listWorkspaceFiles(path: fileExplorerPath)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func goToWorkspaceRoot() async {
    fileExplorerPath = "."
    do {
      workspaceFiles = try await client.listWorkspaceFiles(path: fileExplorerPath)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func updateProvider(
    providerId: ProviderId,
    enabled: Bool? = nil,
    endpoint: String? = nil,
    defaultModel: String? = nil
  ) async {
    do {
      let provider = try await client.updateProvider(
        providerId: providerId,
        update: ProviderConfigUpdate(
          enabled: enabled,
          endpoint: endpoint,
          defaultModel: defaultModel
        )
      )
      upsert(provider)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func saveProviderAPIKey(providerId: ProviderId, apiKey: String) async {
    let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return
    }

    do {
      try credentialStore.saveAPIKey(trimmed, providerId: providerId)
      await refreshProviders()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func testProvider(providerId: ProviderId) async {
    do {
      providerTestResults[providerId] = try await client.testProvider(providerId: providerId)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func createTestTask() async {
    await createTask(
      title: "Mac app smoke task",
      prompt: "Verify that Operator Dock can create a task and receive the corresponding live event.",
      metadata: [
        "source": .string("mac-app"),
        "demo": .boolean(true)
      ]
    )
  }

  func createTaskFromComposer() async {
    let trimmed = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return
    }

    let title = trimmed.count > 72 ? String(trimmed.prefix(69)) + "..." : trimmed
    await createTask(
      title: title,
      prompt: trimmed,
      metadata: [
        "source": .string("command-composer")
      ]
    )
    commandText = ""
    selectedSection = .tasks
  }

  private func createTask(title: String, prompt: String, metadata: [String: JSONValue]) async {
    guard !isCreatingTestTask else {
      return
    }

    isCreatingTestTask = true
    defer {
      isCreatingTestTask = false
    }

    do {
      let task = try await client.createTask(
        title: title,
        prompt: prompt,
        metadata: metadata
      )
      upsert(task)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  private func listenForEvents() async {
    connectionState = .connecting

    do {
      for try await event in client.events() {
        connectionState = .connected
        events.insert(event, at: 0)

        if let task = event.task {
          upsert(task)
        }
      }
    } catch is CancellationError {
      connectionState = .disconnected
    } catch {
      connectionState = .disconnected
      lastError = error.localizedDescription
    }
  }

  private func upsert(_ task: DockTask) {
    if let index = tasks.firstIndex(where: { $0.id == task.id }) {
      tasks[index] = task
    } else {
      tasks.insert(task, at: 0)
    }
  }

  private func upsert(_ provider: ProviderConfig) {
    if let index = providers.firstIndex(where: { $0.id == provider.id }) {
      providers[index] = provider
    } else {
      providers.append(provider)
    }
  }
}
