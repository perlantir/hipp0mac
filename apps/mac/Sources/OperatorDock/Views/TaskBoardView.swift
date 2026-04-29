import SwiftUI

struct TaskBoardView: View {
  @Bindable var store: AppStore

  var body: some View {
    VStack(spacing: 0) {
      HeaderView(store: store)

      Divider()

      HSplitView {
        taskList
          .frame(minWidth: 420)

        eventList
          .frame(minWidth: 360)
      }
    }
    .navigationTitle("Tasks")
  }

  private var taskList: some View {
    VStack(alignment: .leading, spacing: 0) {
      List(store.tasks) { task in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(task.title)
              .font(.headline)
              .lineLimit(1)

            Spacer()

            Text(task.status.displayName)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Text(task.prompt)
            .font(.callout)
            .foregroundStyle(.secondary)
            .lineLimit(2)

          Text(task.createdAt)
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
      }
    }
  }

  private var eventList: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Events")
        .font(.headline)
        .padding([.top, .horizontal])

      List(store.events) { event in
        VStack(alignment: .leading, spacing: 4) {
          Text(event.type)
            .font(.callout)

          Text(event.summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)

          Text(event.occurredAt)
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
      }
    }
  }
}

private struct HeaderView: View {
  let store: AppStore

  var body: some View {
    HStack(spacing: 12) {
      Label(store.connectionState.rawValue, systemImage: connectionImage)
        .foregroundStyle(connectionStyle)

      if let health = store.health {
        Text(health.service)
          .foregroundStyle(.secondary)

        Text(health.version)
          .foregroundStyle(.tertiary)
      }

      Spacer()

      if let lastError = store.lastError {
        Text(lastError)
          .foregroundStyle(.red)
          .lineLimit(1)
      }
    }
    .font(.callout)
    .padding()
  }

  private var connectionImage: String {
    switch store.connectionState {
    case .disconnected: "bolt.slash"
    case .connecting: "bolt.horizontal"
    case .connected: "bolt.horizontal.fill"
    }
  }

  private var connectionStyle: AnyShapeStyle {
    switch store.connectionState {
    case .disconnected: AnyShapeStyle(.secondary)
    case .connecting: AnyShapeStyle(.orange)
    case .connected: AnyShapeStyle(.green)
    }
  }
}
