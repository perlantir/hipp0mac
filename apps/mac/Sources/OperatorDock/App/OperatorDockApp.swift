import AppKit
import SwiftUI
import OperatorDockCore

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var daemonSupervisor: DaemonSupervisor?

  func applicationDidFinishLaunching(_ notification: Notification) {
    daemonSupervisor = DaemonSupervisor.live()
    try? daemonSupervisor?.start()
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    daemonSupervisor?.stop()
  }
}

@main
struct OperatorDockApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var store = AppStore(client: DaemonClient())

  var body: some Scene {
    WindowGroup("Operator Dock", id: "main") {
      ContentView(store: store)
        .frame(minWidth: 980, minHeight: 640)
    }
    .commands {
      SidebarCommands()
      CommandMenu("Task") {
        Button("Create Test Task") {
          Task {
            await store.createTestTask()
          }
        }
        .keyboardShortcut("n", modifiers: [.command])
      }
    }

    Settings {
      SettingsView(store: store)
    }
  }
}
