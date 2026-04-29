import SwiftUI

struct WorkspaceScreen: View {
  @Bindable var store: AppStore
  @State private var showApproval = false

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        workspaceStatusBar

        HStack(spacing: 12) {
          leftPane
            .frame(width: 320)

          centerPane
            .frame(maxWidth: .infinity)

          inspectorPane
            .frame(width: 320)
        }
        .padding(.horizontal, ODTheme.Space.page)
        .padding(.bottom, 14)

        bottomComposer
      }

      if showApproval {
        Color.black.opacity(0.42)
          .ignoresSafeArea()
          .onTapGesture {
            showApproval = false
          }

        ApprovalModal(
          title: "Send 14 emails to design partners",
          details: "Operator Dock wants to send partner emails using the generated launch announcement. Review the scope before continuing.",
          onApprove: { showApproval = false },
          onDecline: { showApproval = false }
        )
      }
    }
    .background(ODTheme.ColorToken.canvas)
  }

  private var workspaceStatusBar: some View {
    HStack(spacing: 14) {
      StatusBadge(status: .running, compact: true)

      VStack(alignment: .leading, spacing: 3) {
        Text("Pull Q2 churn cohorts from Mixpanel")
          .font(.odText(13.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text("Inspecting pricing page...")
          .font(.odText(11.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
      }

      Spacer()

      WorkspaceMetric(label: "Model", value: "Auto")
      WorkspaceMetric(label: "Runtime", value: "04:12")
      WorkspaceMetric(label: "Cost", value: "$0.84")

      Button {
        showApproval = true
      } label: {
        Label("2 pending", systemImage: "checkmark.shield")
          .font(.odText(11.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.waiting)
          .frame(height: 24)
          .padding(.horizontal, 9)
          .background(ODTheme.ColorToken.waiting.opacity(0.12))
          .clipShape(Capsule())
      }
      .buttonStyle(.plain)

      PillButton(title: "", systemImage: "pause", style: .secondary) {}
      PillButton(title: "", systemImage: "stop.fill", style: .secondary) {}
    }
    .frame(height: 56)
    .padding(.horizontal, ODTheme.Space.page)
    .padding(.top, 32)
  }

  private var leftPane: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 6) {
        WorkspaceSegment(title: "Chat", active: true)
        WorkspaceSegment(title: "Plan")
        WorkspaceSegment(title: "Timeline")
      }

      StepTimelineCard(steps: SampleData.planSteps)
    }
  }

  private var centerPane: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        WorkspaceSegment(title: "Browser", active: true)
        WorkspaceSegment(title: "Terminal")
        WorkspaceSegment(title: "Preview")
        Spacer()
      }

      VStack(alignment: .leading, spacing: 18) {
        HStack {
          Text("https://mixpanel.com/project/cohorts")
            .font(.odMono(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ODTheme.ColorToken.canvas)
            .clipShape(Capsule())
        }

        VStack(alignment: .leading, spacing: 14) {
          Text("Cohort retention by pricing experiment")
            .font(.odText(15, weight: .semibold))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)

          HStack(alignment: .bottom, spacing: 10) {
            ForEach([0.72, 0.58, 0.64, 0.49, 0.41, 0.36, 0.31], id: \.self) { value in
              RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(ODTheme.ColorToken.accent.opacity(0.75))
                .frame(height: 220 * value)
            }
          }
          .frame(maxWidth: .infinity, minHeight: 230, alignment: .bottom)
          .padding(18)
          .background(ODTheme.ColorToken.canvas)
          .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.xl, style: .continuous))

          Text("Click Export CSV")
            .font(.odText(11.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(ODTheme.ColorToken.accent)
            .clipShape(Capsule())
        }

        Spacer()
      }
      .padding(18)
      .odCard(fill: ODTheme.ColorToken.surface)
    }
  }

  private var inspectorPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        SectionLabel(title: "Current tool")
        ForEach(SampleData.tools) { tool in
          ToolCallCard(tool: tool)
        }

        SectionLabel(title: "Approvals", count: "2")
        Button {
          showApproval = true
        } label: {
          HStack {
            Label("Review Gmail send", systemImage: "checkmark.shield")
              .font(.odText(12.5, weight: .medium))
            Spacer()
            Text("Review")
              .font(.odText(11.5, weight: .medium))
          }
          .foregroundStyle(ODTheme.ColorToken.waiting)
          .padding(14)
          .odCard(fill: ODTheme.ColorToken.waiting.opacity(0.09))
        }
        .buttonStyle(.plain)

        SectionLabel(title: "Memory used")
        VStack(spacing: 0) {
          ForEach(SampleData.memory) { record in
            MemoryRecordRow(record: record)
          }
        }
        .padding(.horizontal, 14)
        .odCard()

        SectionLabel(title: "Files touched")
        ForEach(SampleData.artifacts.prefix(2)) { artifact in
          ArtifactCard(artifact: artifact)
        }
      }
      .padding(.bottom, 12)
    }
  }

  private var bottomComposer: some View {
    CommandComposer(
      text: $store.commandText,
      placeholder: "Add an instruction mid-task - Operator Dock will weave it in.",
      isSubmitting: store.isCreatingTestTask
    ) {
      Task {
        await store.createTaskFromComposer()
      }
    }
    .padding(.horizontal, ODTheme.Space.page)
    .padding(.bottom, 18)
  }
}

private struct WorkspaceMetric: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.odText(10.5))
        .foregroundStyle(ODTheme.ColorToken.textMuted)

      Text(value)
        .font(.odMono(11.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)
    }
    .padding(.horizontal, 10)
  }
}

private struct WorkspaceSegment: View {
  let title: String
  var active = false

  var body: some View {
    Text(title)
      .font(.odText(11.5, weight: .medium))
      .foregroundStyle(active ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textTertiary)
      .frame(height: 28)
      .padding(.horizontal, 10)
      .background(active ? ODTheme.ColorToken.surfaceRaised : Color.clear)
      .clipShape(Capsule())
  }
}

