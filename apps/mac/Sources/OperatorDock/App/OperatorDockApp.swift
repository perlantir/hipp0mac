import AppKit
import SwiftUI
import OperatorDockCore

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
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

