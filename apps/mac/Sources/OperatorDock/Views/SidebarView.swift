import SwiftUI

enum SidebarSection: String, CaseIterable, Identifiable {
  case tasks
  case projects
  case memory
  case schedules
  case artifacts
  case settings

  var id: String {
    rawValue
  }

  var title: String {
    switch self {
    case .tasks: "Tasks"
    case .projects: "Projects"
    case .memory: "Memory"
    case .schedules: "Schedules"
    case .artifacts: "Artifacts"
    case .settings: "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .tasks: "checklist"
    case .projects: "folder"
    case .memory: "brain"
    case .schedules: "calendar.badge.clock"
    case .artifacts: "shippingbox"
    case .settings: "gearshape"
    }
  }
}

struct SidebarView: View {
  @Binding var selection: SidebarSection

  var body: some View {
    List(selection: $selection) {
      Section("Workspace") {
        ForEach(SidebarSection.allCases) { section in
          Label(section.title, systemImage: section.systemImage)
            .tag(section)
        }
      }
    }
    .listStyle(.sidebar)
    .navigationTitle("Operator Dock")
  }
}

