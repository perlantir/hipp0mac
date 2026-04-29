import SwiftUI

struct SkillsScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Skills",
        subtitle: "Reusable capabilities Operator Dock can invoke during a task."
      ) {
        PillButton(title: "Install skill", systemImage: "plus", style: .primary) {}
      }

      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          SectionLabel(title: "Installed", count: "\(SampleData.skills.count)")

          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
            ForEach(SampleData.skills) { skill in
              SkillCard(skill: skill)
            }
          }

          SectionLabel(title: "Recent runs")

          VStack(spacing: 0) {
            ForEach(SampleData.tasks) { task in
              HStack {
                Text(task.tag)
                  .frame(width: 150, alignment: .leading)
                Text(task.title)
                  .frame(maxWidth: .infinity, alignment: .leading)
                Text(task.cost)
                  .frame(width: 70, alignment: .leading)
                StatusBadge(status: task.status)
              }
              .font(.odText(12))
              .foregroundStyle(ODTheme.ColorToken.textSecondary)
              .padding(.horizontal, 14)
              .frame(height: 46)
            }
          }
          .odCard()
        }
        .padding(.horizontal, ODTheme.Space.page)
        .padding(.bottom, ODTheme.Space.page)
      }
    }
    .background(ODTheme.ColorToken.canvas)
  }
}

