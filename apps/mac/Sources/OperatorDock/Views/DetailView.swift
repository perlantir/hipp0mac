import SwiftUI

struct DetailView: View {
  @Bindable var store: AppStore

  var body: some View {
    ZStack {
      switch store.selectedSection {
      case .home:
        HomeDashboardView(store: store)
      case .tasks:
        TasksListScreen(store: store)
      case .workspace:
        WorkspaceScreen(store: store)
      case .projects:
        ProjectsScreen()
      case .memory:
        MemoryScreen()
      case .skills:
        SkillsScreen()
      case .integrations:
        IntegrationsScreen()
      case .schedules:
        SchedulesScreen()
      case .artifacts:
        ArtifactsScreen()
      case .settings:
        SettingsView(store: store)
      }
    }
  }
}

