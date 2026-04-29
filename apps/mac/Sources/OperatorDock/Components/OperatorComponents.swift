import SwiftUI

struct SidebarItem: View {
  let section: SidebarSection
  let isActive: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: section.systemImage)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(isActive ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textTertiary)
          .frame(width: 18)

        Text(section.title)
          .font(.odText(13.5, weight: isActive ? .medium : .regular))
          .foregroundStyle(isActive ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textSecondary)
          .lineLimit(1)

        Spacer(minLength: 8)

        if let badge = section.badge {
          Text(badge)
            .font(.odMono(11))
            .foregroundStyle(ODTheme.ColorToken.textMuted)
        }
      }
      .frame(height: 34)
      .padding(.horizontal, 14)
      .background(isActive ? ODTheme.ColorToken.surfaceRaised : Color.clear)
      .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

struct StatusBadge: View {
  let status: WorkStatus
  var compact = false

  var body: some View {
    HStack(spacing: 7) {
      StatusDot(status: status, pulsing: status == .running)

      if !compact {
        Text(status.label)
          .font(.odText(11.5, weight: .medium))
          .foregroundStyle(statusColor)
      }
    }
    .padding(.horizontal, compact ? 0 : 9)
    .frame(height: compact ? 10 : 23)
    .background(compact ? Color.clear : statusColor.opacity(0.12))
    .clipShape(Capsule())
  }

  private var statusColor: Color {
    switch status {
    case .running: ODTheme.ColorToken.accent
    case .waiting: ODTheme.ColorToken.waiting
    case .success: ODTheme.ColorToken.success
    case .queued: ODTheme.ColorToken.textTertiary
    case .failed: ODTheme.ColorToken.error
    }
  }
}

private struct StatusDot: View {
  let status: WorkStatus
  let pulsing: Bool

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 7, height: 7)
      .overlay {
        if pulsing {
          Circle()
            .stroke(color.opacity(0.22), lineWidth: 5)
            .frame(width: 15, height: 15)
        }
      }
  }

  private var color: Color {
    switch status {
    case .running: ODTheme.ColorToken.accent
    case .waiting: ODTheme.ColorToken.waiting
    case .success: ODTheme.ColorToken.success
    case .queued: ODTheme.ColorToken.textTertiary
    case .failed: ODTheme.ColorToken.error
    }
  }
}

struct CommandComposer: View {
  @Binding var text: String
  let placeholder: String
  let isSubmitting: Bool
  let onSubmit: () -> Void

  init(
    text: Binding<String>,
    placeholder: String,
    isSubmitting: Bool = false,
    onSubmit: @escaping () -> Void
  ) {
    _text = text
    self.placeholder = placeholder
    self.isSubmitting = isSubmitting
    self.onSubmit = onSubmit
  }

  var body: some View {
    VStack(spacing: 12) {
      ZStack(alignment: .topLeading) {
        TextEditor(text: $text)
          .font(.odText(15))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
          .scrollContentBackground(.hidden)
          .frame(minHeight: 58, maxHeight: 96)

        if text.isEmpty {
          Text(placeholder)
            .font(.odText(15))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
            .padding(.top, 8)
            .padding(.leading, 5)
            .allowsHitTesting(false)
        }
      }

      HStack(spacing: 8) {
        ComposerChip(systemImage: "paperclip", title: nil)
        ComposerChip(systemImage: "sparkles", title: "Plan")
        ComposerChip(systemImage: "globe", title: "Research")
        ComposerChip(systemImage: "hammer", title: "Build")

        Spacer()

        ComposerChip(systemImage: "mic", title: nil)

        Button(action: onSubmit) {
          Image(systemName: isSubmitting ? "hourglass" : "arrow.up")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
            .frame(width: 36, height: 36)
            .background(ODTheme.ColorToken.accent)
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(.top, 14)
    .padding(.horizontal, 18)
    .padding(.bottom, 14)
    .odCard(radius: ODTheme.Radius.modal, fill: ODTheme.ColorToken.surface)
  }
}

private struct ComposerChip: View {
  let systemImage: String
  let title: String?

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: systemImage)
        .font(.system(size: 13, weight: .medium))

      if let title {
        Text(title)
          .font(.odText(12.5, weight: .medium))
      }
    }
    .foregroundStyle(ODTheme.ColorToken.textSecondary)
    .frame(height: 32)
    .padding(.horizontal, title == nil ? 10 : 12)
    .background(ODTheme.ColorToken.canvas)
    .clipShape(Capsule())
    .overlay(Capsule().stroke(ODTheme.ColorToken.border, lineWidth: 1))
  }
}

struct TaskCard: View {
  let task: OperatorTask

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        StatusBadge(status: task.status, compact: true)

        Text(task.status.label)
          .font(.odText(11.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)

        Spacer()

        Text(task.tag)
          .font(.odText(11))
          .foregroundStyle(ODTheme.ColorToken.textMuted)
      }

      Text(task.title)
        .font(.odText(13.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
        .lineLimit(2)

      Text(task.detail)
        .font(.odText(11.5))
        .foregroundStyle(ODTheme.ColorToken.textTertiary)
        .lineLimit(2)
    }
    .padding(18)
    .odCard()
  }
}

struct StepTimelineCard: View {
  let steps: [PlanStep]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
        HStack(alignment: .top, spacing: 12) {
          VStack(spacing: 0) {
            stepMarker(step.state)

            if index < steps.count - 1 {
              Rectangle()
                .fill(ODTheme.ColorToken.borderStrong)
                .frame(width: 1)
                .frame(maxHeight: .infinity)
                .padding(.vertical, 4)
            }
          }
          .frame(width: 16)

          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
              Text(step.title)
                .font(.odText(12.5, weight: .medium))
                .foregroundStyle(ODTheme.ColorToken.textPrimary)

              if step.requiresApproval {
                Text("Approval")
                  .font(.odText(10.5, weight: .medium))
                  .foregroundStyle(ODTheme.ColorToken.waiting)
                  .padding(.horizontal, 7)
                  .frame(height: 20)
                  .background(ODTheme.ColorToken.waiting.opacity(0.12))
                  .clipShape(Capsule())
              }
            }

            Text(step.detail)
              .font(.odText(11.5))
              .foregroundStyle(ODTheme.ColorToken.textTertiary)
          }
          .padding(.bottom, index == steps.count - 1 ? 0 : 18)

          Spacer()
        }
      }
    }
    .padding(16)
    .odCard()
  }

  @ViewBuilder
  private func stepMarker(_ state: PlanStep.State) -> some View {
    switch state {
    case .done:
      Image(systemName: "checkmark")
        .font(.system(size: 8, weight: .bold))
        .foregroundStyle(ODTheme.ColorToken.canvas)
        .frame(width: 14, height: 14)
        .background(ODTheme.ColorToken.success)
        .clipShape(Circle())
    case .active:
      Circle()
        .fill(ODTheme.ColorToken.accent)
        .frame(width: 14, height: 14)
        .overlay(Circle().stroke(ODTheme.ColorToken.accent.opacity(0.22), lineWidth: 6))
    case .pending:
      Circle()
        .stroke(ODTheme.ColorToken.borderStrong, lineWidth: 1.5)
        .frame(width: 14, height: 14)
    }
  }
}

struct ToolCallCard: View {
  let tool: ToolCallRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        StatusBadge(status: tool.status, compact: true)

        Text(tool.name)
          .font(.odMono(11.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Spacer()

        Text(tool.status.label)
          .font(.odText(11))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(ODTheme.ColorToken.surfaceRaised)

      VStack(alignment: .leading, spacing: 10) {
        CodeBlock(label: "Input", text: tool.input)
        CodeBlock(label: "Output", text: tool.output)
      }
      .padding(12)
    }
    .odCard()
  }
}

private struct CodeBlock: View {
  let label: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label)
        .font(.odText(10.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textMuted)
        .textCase(.uppercase)

      Text(text)
        .font(.odMono(11))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)
        .lineLimit(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(ODTheme.ColorToken.canvas)
        .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.md, style: .continuous))
    }
  }
}

struct ArtifactCard: View {
  let artifact: ArtifactRecord

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: artifactIcon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
        .frame(width: 34, height: 34)
        .background(ODTheme.ColorToken.subtle)
        .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))

      VStack(alignment: .leading, spacing: 3) {
        Text(artifact.name)
          .font(.odText(12.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
          .lineLimit(1)

        Text(artifact.location)
          .font(.odText(11))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
          .lineLimit(1)
      }

      Spacer()

      StatusBadge(status: artifact.status)
    }
    .padding(14)
    .odCard()
  }

  private var artifactIcon: String {
    switch artifact.kind.lowercased() {
    case "csv": "tablecells"
    case "markdown": "doc.text"
    case "log": "terminal"
    default: "doc"
    }
  }
}

struct IntegrationCard: View {
  let integration: IntegrationRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        LetterAvatar(text: integration.name, color: ODTheme.ColorToken.browser)

        VStack(alignment: .leading, spacing: 3) {
          Text(integration.name)
            .font(.odText(13.5, weight: .semibold))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)

          Text(integration.account)
            .font(.odText(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
        }

        Spacer()
        StatusBadge(status: integration.status)
      }

      HStack(spacing: 6) {
        ForEach(integration.scopes, id: \.self) { scope in
          Text(scope)
            .font(.odText(10.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textSecondary)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(ODTheme.ColorToken.canvas)
            .clipShape(Capsule())
        }
      }
    }
    .padding(18)
    .odCard()
  }
}

struct SkillCard: View {
  let skill: SkillRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        LetterAvatar(text: skill.name, color: ODTheme.ColorToken.tool)

        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 5) {
            Text(skill.name)
              .font(.odText(13.5, weight: .semibold))
              .foregroundStyle(ODTheme.ColorToken.textPrimary)

            if skill.verified {
              Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 12))
                .foregroundStyle(ODTheme.ColorToken.success)
            }
          }

          Text(skill.vendor)
            .font(.odText(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
        }
      }

      Text(skill.usage)
        .font(.odText(11.5))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)
    }
    .padding(18)
    .odCard()
  }
}

struct MemoryRecordRow: View {
  let record: MemoryRecord

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ODTheme.ColorToken.memory)
        .frame(width: 9, height: 9)

      VStack(alignment: .leading, spacing: 3) {
        Text(record.title)
          .font(.odText(12.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
          .lineLimit(1)

        Text("\(record.kind) · \(record.source)")
          .font(.odText(11))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
      }

      Spacer()

      ConfidenceBar(value: record.confidence)
        .frame(width: 84)
    }
    .padding(.vertical, 10)
  }
}

private struct ConfidenceBar: View {
  let value: Double

  var body: some View {
    VStack(alignment: .trailing, spacing: 5) {
      Text("\(Int(value * 100))%")
        .font(.odMono(10.5))
        .foregroundStyle(ODTheme.ColorToken.textTertiary)

      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(ODTheme.ColorToken.muted)

          Capsule()
            .fill(ODTheme.ColorToken.success)
            .frame(width: proxy.size.width * value)
        }
      }
      .frame(height: 4)
    }
  }
}

struct ApprovalScope: Identifiable {
  let id = UUID()
  let icon: String
  let title: String
  let detail: String
}

struct ApprovalModal: View {
  let title: String
  let details: String
  var scopes: [ApprovalScope] = []
  let onApprove: () -> Void
  let onDecline: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Needs approval")
            .font(.odText(11, weight: .semibold))
            .foregroundStyle(ODTheme.ColorToken.waiting)
            .textCase(.uppercase)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(ODTheme.ColorToken.waiting.opacity(0.14))
            .clipShape(Capsule())

          Spacer()
        }

        Text(title)
          .font(.odDisplay(22, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text(details)
          .font(.odText(13))
          .foregroundStyle(ODTheme.ColorToken.textSecondary)
          .lineSpacing(2)
      }
      .padding(28)

      Divider()
        .overlay(ODTheme.ColorToken.border)

      if !scopes.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(scopes) { scope in
            ApprovalScopeRow(icon: scope.icon, title: scope.title, detail: scope.detail)
          }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 18)

        Divider()
          .overlay(ODTheme.ColorToken.border)
      }

      HStack(spacing: 12) {
        Label("Trust similar runs", systemImage: "checkmark.shield")
          .font(.odText(12))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)

        Spacer()

        PillButton(title: "Decline", style: .secondary, action: onDecline)
        PillButton(title: "Approve and run", style: .primary, action: onApprove)
      }
      .padding(20)
    }
    .frame(width: 540)
    .background(ODTheme.ColorToken.surface)
    .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.modal, style: .continuous))
    .shadow(color: .black.opacity(0.4), radius: 40, x: 0, y: 24)
    .overlay(
      RoundedRectangle(cornerRadius: ODTheme.Radius.modal, style: .continuous)
        .stroke(ODTheme.ColorToken.borderStrong, lineWidth: 1)
    )
  }
}

private struct ApprovalScopeRow: View {
  let icon: String
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: icon)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)
        .frame(width: 24, height: 24)
        .background(ODTheme.ColorToken.subtle)
        .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.sm, style: .continuous))

      Text(title)
        .font(.odText(12.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)

      Text(detail)
        .font(.odText(11.5))
        .foregroundStyle(ODTheme.ColorToken.textTertiary)

      Spacer()
    }
  }
}

struct PillButton: View {
  enum Style {
    case primary
    case secondary
    case ghost
  }

  let title: String
  var systemImage: String?
  var style: Style = .secondary
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        if let systemImage {
          Image(systemName: systemImage)
            .font(.system(size: 12, weight: .semibold))
        }

        Text(title)
          .font(.odText(12.5, weight: .medium))
      }
      .foregroundStyle(foreground)
      .frame(height: 34)
      .padding(.horizontal, 14)
      .background(background)
      .clipShape(Capsule())
      .overlay(Capsule().stroke(border, lineWidth: style == .ghost ? 0 : 1))
    }
    .buttonStyle(.plain)
  }

  private var foreground: Color {
    switch style {
    case .primary: ODTheme.ColorToken.textPrimary
    case .secondary, .ghost: ODTheme.ColorToken.textSecondary
    }
  }

  private var background: Color {
    switch style {
    case .primary: ODTheme.ColorToken.accent
    case .secondary: ODTheme.ColorToken.surfaceRaised
    case .ghost: Color.clear
    }
  }

  private var border: Color {
    switch style {
    case .primary: ODTheme.ColorToken.accent
    case .secondary: ODTheme.ColorToken.border
    case .ghost: Color.clear
    }
  }
}

struct LetterAvatar: View {
  let text: String
  var color: Color

  var body: some View {
    Text(String(text.prefix(1)).uppercased())
      .font(.odText(16, weight: .semibold))
      .foregroundStyle(ODTheme.ColorToken.textPrimary)
      .frame(width: 38, height: 38)
      .background(color)
      .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))
  }
}

struct ScreenHeader<Actions: View>: View {
  let title: String
  let subtitle: String
  @ViewBuilder let actions: Actions

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 5) {
        Text(title)
          .font(.odDisplay(24, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text(subtitle)
          .font(.odText(12.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
      }

      Spacer()

      actions
    }
    .padding(.horizontal, ODTheme.Space.page)
    .padding(.top, 32)
    .padding(.bottom, 18)
  }
}

struct SectionLabel: View {
  let title: String
  var count: String?

  var body: some View {
    HStack(spacing: 8) {
      Text(title)
        .font(.odText(11, weight: .semibold))
        .foregroundStyle(ODTheme.ColorToken.textMuted)
        .textCase(.uppercase)

      if let count {
        Text(count)
          .font(.odMono(10.5))
          .foregroundStyle(ODTheme.ColorToken.textMuted)
      }
    }
  }
}
