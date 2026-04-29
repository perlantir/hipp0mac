import SwiftUI

struct ProjectsScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Projects",
        subtitle: "Workspace-level initiatives, artifacts, and task history."
      ) {
        PillButton(title: "New project", systemImage: "plus", style: .primary) {}
      }

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
        ForEach(SampleData.projects) { project in
          VStack(alignment: .leading, spacing: 14) {
            HStack {
              LetterAvatar(text: project.name, color: ODTheme.ColorToken.accentSoft)
              Spacer()
              StatusBadge(status: project.status)
            }

            VStack(alignment: .leading, spacing: 6) {
              Text(project.name)
                .font(.odText(14, weight: .semibold))
                .foregroundStyle(ODTheme.ColorToken.textPrimary)
                .lineLimit(1)

              Text(project.summary)
                .font(.odText(12))
                .foregroundStyle(ODTheme.ColorToken.textTertiary)
                .lineLimit(3)
            }

            Text(project.updated)
              .font(.odText(11.5))
              .foregroundStyle(ODTheme.ColorToken.textMuted)
          }
          .padding(18)
          .odCard()
        }
      }
      .padding(.horizontal, ODTheme.Space.page)

      Spacer()
    }
    .background(ODTheme.ColorToken.canvas)
  }
}

