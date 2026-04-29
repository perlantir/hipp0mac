import SwiftUI

enum SidebarSection: String, CaseIterable, Identifiable {
  case home
  case tasks
  case workspace
  case projects
  case memory
  case skills
  case integrations
  case schedules
  case artifacts
  case settings

  var id: String {
    rawValue
  }

  var title: String {
    switch self {
    case .home: "Home"
    case .tasks: "Tasks"
    case .workspace: "Workspace"
    case .projects: "Projects"
    case .memory: "Memory"
    case .skills: "Skills"
    case .integrations: "Integrations"
    case .schedules: "Schedules"
    case .artifacts: "Artifacts"
    case .settings: "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .home: "house"
    case .tasks: "checklist"
    case .workspace: "rectangle.3.group"
    case .projects: "folder"
    case .memory: "brain"
    case .skills: "sparkles"
    case .integrations: "point.3.connected.trianglepath.dotted"
    case .schedules: "calendar.badge.clock"
    case .artifacts: "shippingbox"
    case .settings: "gearshape"
    }
  }

  var badge: String? {
    switch self {
    case .tasks: "12"
    case .integrations: "4"
    default: nil
    }
  }
}

struct SidebarGroup: Identifiable {
  let id: String
  let title: String?
  let sections: [SidebarSection]
}

extension SidebarGroup {
  static let defaultGroups: [SidebarGroup] = [
    SidebarGroup(
      id: "primary",
      title: nil,
      sections: [.home, .tasks, .workspace, .projects, .schedules, .artifacts]
    ),
    SidebarGroup(
      id: "knowledge",
      title: "Knowledge",
      sections: [.memory, .skills, .integrations]
    ),
    SidebarGroup(
      id: "system",
      title: "System",
      sections: [.settings]
    )
  ]
}

