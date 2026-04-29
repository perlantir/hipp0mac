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
  var selectedSection: SidebarSection = .tasks
  var connectionState: ConnectionState = .disconnected
  var health: HealthResponse?
  var tasks: [DockTask] = []
  var events: [OperatorEvent] = []
  var isCreatingTestTask = false
  var lastError: String?

  private let client: DaemonClient
  private var eventStreamTask: Swift.Task<Void, Never>?

  init(client: DaemonClient) {
    self.client = client
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

  func createTestTask() async {
    guard !isCreatingTestTask else {
      return
    }

    isCreatingTestTask = true
    defer {
      isCreatingTestTask = false
    }

    do {
      let task = try await client.createTask(
        title: "Mac app smoke task",
        prompt: "Verify that Operator Dock can create a task and receive the corresponding live event.",
        metadata: [
          "source": .string("mac-app"),
          "demo": .boolean(true)
        ]
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
}
