import SwiftUI

struct TasksListScreen: View {
  @Bindable var store: AppStore

  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Tasks",
        subtitle: "Live autonomous work, approvals, and completed runs."
      ) {
        PillButton(title: "Filter", systemImage: "line.3.horizontal.decrease.circle", style: .secondary) {}
        PillButton(title: "New task", systemImage: "plus", style: .primary) {
          Task {
            await store.createTestTask()
          }
        }
      }

      HStack(spacing: 8) {
        TaskTab(title: "Active", count: "4", active: true)
        TaskTab(title: "Waiting", count: "2")
        TaskTab(title: "Completed", count: "38")
        TaskTab(title: "All", count: "\(store.displayTasks.count)")
        Spacer()
      }
      .padding(.horizontal, ODTheme.Space.page)
      .padding(.bottom, 14)

      VStack(spacing: 0) {
        tableHeader

        ForEach(store.displayTasks) { task in
          TaskTableRow(task: task)
        }
      }
      .padding(10)
      .odCard(fill: ODTheme.ColorToken.surface)
      .padding(.horizontal, ODTheme.Space.page)
      .padding(.bottom, ODTheme.Space.page)

      Spacer(minLength: 0)
    }
    .background(ODTheme.ColorToken.canvas)
  }

  private var tableHeader: some View {
    HStack(spacing: 12) {
      Text("Task")
        .frame(maxWidth: .infinity, alignment: .leading)
      Text("Source")
        .frame(width: 90, alignment: .leading)
      Text("Started")
        .frame(width: 96, alignment: .leading)
      Text("Cost")
        .frame(width: 72, alignment: .leading)
      Text("Status")
        .frame(width: 104, alignment: .leading)
      Image(systemName: "ellipsis")
        .frame(width: 28)
    }
    .font(.odText(11, weight: .semibold))
    .foregroundStyle(ODTheme.ColorToken.textMuted)
    .textCase(.uppercase)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

private struct TaskTab: View {
  let title: String
  let count: String
  var active = false

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
      Text(count)
        .font(.odMono(11))
    }
    .font(.odText(12.5, weight: .medium))
    .foregroundStyle(active ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textTertiary)
    .frame(height: 32)
    .padding(.horizontal, 12)
    .background(active ? ODTheme.ColorToken.surface : Color.clear)
    .clipShape(Capsule())
    .overlay(Capsule().stroke(active ? ODTheme.ColorToken.borderStrong : ODTheme.ColorToken.border, lineWidth: 1))
  }
}

private struct TaskTableRow: View {
  let task: OperatorTask

  var body: some View {
    HStack(spacing: 12) {
      HStack(spacing: 12) {
        StatusBadge(status: task.status, compact: true)

        VStack(alignment: .leading, spacing: 4) {
          Text(task.title)
            .font(.odText(13, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
            .lineLimit(1)

          Text(task.detail)
            .font(.odText(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      Text(task.source)
        .frame(width: 90, alignment: .leading)
      Text(task.started)
        .frame(width: 96, alignment: .leading)
      Text(task.cost)
        .frame(width: 72, alignment: .leading)
      StatusBadge(status: task.status)
        .frame(width: 104, alignment: .leading)
      Image(systemName: "ellipsis")
        .foregroundStyle(ODTheme.ColorToken.textMuted)
        .frame(width: 28)
    }
    .font(.odText(12))
    .foregroundStyle(ODTheme.ColorToken.textSecondary)
    .padding(.horizontal, 14)
    .frame(height: 64)
    .background(ODTheme.ColorToken.surface.opacity(0.001))
    .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.xl, style: .continuous))
  }
}

