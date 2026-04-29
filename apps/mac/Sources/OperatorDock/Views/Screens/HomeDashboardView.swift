import SwiftUI

struct HomeDashboardView: View {
  @Bindable var store: AppStore

  var body: some View {
    ScrollView {
      VStack(spacing: 32) {
        topbar

        VStack(spacing: 28) {
          glyph

          VStack(spacing: 10) {
            Text("Good morning, Rae.")
              .font(.odDisplay(30, weight: .medium))
              .foregroundStyle(ODTheme.ColorToken.textPrimary)

            Text("What should Operator Dock get done today?")
              .font(.odText(15))
              .foregroundStyle(ODTheme.ColorToken.textTertiary)
          }

          modePills

          CommandComposer(
            text: $store.commandText,
            placeholder: "Describe the autonomous work you want Operator Dock to run...",
            isSubmitting: store.isCreatingTestTask
          ) {
            Task {
              await store.createTaskFromComposer()
            }
          }
          .frame(maxWidth: 720)

          suggestions
        }
        .padding(.horizontal, 64)
        .padding(.top, 48)

        continueBand
          .padding(.horizontal, 64)
          .padding(.bottom, 40)
      }
    }
    .scrollContentBackground(.hidden)
    .background(ODTheme.ColorToken.canvas)
  }

  private var topbar: some View {
    HStack {
      Spacer()

      PillButton(title: "Temporary", systemImage: "sparkles", style: .secondary) {}
      LetterAvatar(text: "Rae", color: ODTheme.ColorToken.accent)
        .frame(width: 32, height: 32)
    }
    .padding(.top, 32)
    .padding(.horizontal, ODTheme.Space.page)
  }

  private var glyph: some View {
    RoundedRectangle(cornerRadius: 16, style: .continuous)
      .fill(ODTheme.ColorToken.surfaceRaised)
      .frame(width: 56, height: 56)
      .overlay {
        Image(systemName: "dock.rectangle")
          .font(.system(size: 27, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
      }
  }

  private var modePills: some View {
    HStack(spacing: 8) {
      ModePill(systemImage: "sparkles", title: "Plan a task", isActive: true)
      ModePill(systemImage: "globe", title: "Research")
      ModePill(systemImage: "cursorarrow.click.2", title: "Operate browser")
      ModePill(systemImage: "hammer", title: "Build app")
      ModePill(systemImage: "brain", title: "Recall memory")
    }
  }

  private var suggestions: some View {
    HStack(spacing: 10) {
      SuggestionChip(title: "Summarize unread Slack since Friday")
      SuggestionChip(title: "Prep brief for Thursday Lattice review")
      SuggestionChip(title: "Find 5 design partners for waitlist")
    }
  }

  private var continueBand: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Continue where you left off")
          .font(.odText(12.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textSecondary)

        Spacer()

        Button {
          store.selectedSection = .tasks
        } label: {
          Text("View all tasks")
            .font(.odText(12))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
        }
        .buttonStyle(.plain)
      }

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
        ForEach(store.displayTasks.prefix(3)) { task in
          TaskCard(task: task)
        }
      }
    }
  }
}

private struct ModePill: View {
  let systemImage: String
  let title: String
  var isActive = false

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: systemImage)
        .font(.system(size: 13, weight: .medium))

      Text(title)
        .font(.odText(12.5, weight: .medium))
    }
    .foregroundStyle(isActive ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textSecondary)
    .frame(height: 34)
    .padding(.horizontal, 14)
    .background(isActive ? ODTheme.ColorToken.surface : Color.clear)
    .clipShape(Capsule())
    .overlay(
      Capsule()
        .stroke(isActive ? ODTheme.ColorToken.accent : ODTheme.ColorToken.border, lineWidth: 1)
    )
  }
}

private struct SuggestionChip: View {
  let title: String

  var body: some View {
    Text(title)
      .font(.odText(12.5))
      .foregroundStyle(ODTheme.ColorToken.textSecondary)
      .frame(height: 32)
      .padding(.horizontal, 14)
      .background(Color.clear)
      .clipShape(Capsule())
      .overlay(Capsule().stroke(ODTheme.ColorToken.border, lineWidth: 1))
  }
}

