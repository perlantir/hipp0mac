import SwiftUI

struct DetailView: View {
  @Bindable var store: AppStore

  var body: some View {
    Group {
      switch store.selectedSection {
      case .tasks:
        TaskBoardView(store: store)
      case .projects:
        PlaceholderPane(title: "Projects", systemImage: "folder")
      case .memory:
        PlaceholderPane(title: "Memory", systemImage: "brain")
      case .schedules:
        PlaceholderPane(title: "Schedules", systemImage: "calendar.badge.clock")
      case .artifacts:
        PlaceholderPane(title: "Artifacts", systemImage: "shippingbox")
      case .settings:
        SettingsView(store: store)
      }
    }
    .toolbar {
      ToolbarItemGroup {
        Button {
          Task {
            await store.refreshHealth()
            await store.refreshTasks()
          }
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }

        Button {
          Task {
            await store.createTestTask()
          }
        } label: {
          Label("New Test Task", systemImage: "plus.circle")
        }
        .disabled(store.isCreatingTestTask)
      }
    }
  }
}

