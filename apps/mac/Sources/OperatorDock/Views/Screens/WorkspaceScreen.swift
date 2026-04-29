import AppKit
import SwiftUI
import OperatorDockCore

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

          FileExplorerPanel(store: store)
            .frame(maxWidth: .infinity)

          inspectorPane
            .frame(width: 320)
        }
        .padding(.horizontal, ODTheme.Space.page)
        .padding(.bottom, 14)

        bottomComposer
      }

      if showApproval, let approval = store.pendingApprovals.first {
        Color.black.opacity(0.42)
          .ignoresSafeArea()
          .onTapGesture {
            showApproval = false
          }

        ApprovalModal(
          title: approval.toolName,
          details: approval.reason,
          scopes: approvalScopes(for: approval),
          onApprove: {
            showApproval = false
            Task {
              await store.resolveToolApproval(approval, approved: true)
            }
          },
          onDecline: {
            showApproval = false
            Task {
              await store.resolveToolApproval(approval, approved: false)
            }
          }
        )
      }
    }
    .background(ODTheme.ColorToken.canvas)
  }

  private func approvalScopes(for approval: ToolApproval) -> [ApprovalScope] {
    [
      ApprovalScope(icon: "terminal", title: "Tool", detail: approval.toolName),
      ApprovalScope(icon: "exclamationmark.shield", title: "Risk", detail: approval.riskLevel.displayName),
      ApprovalScope(icon: "number", title: "Execution", detail: String(approval.executionId.prefix(8)))
    ]
  }

  private var workspaceStatusBar: some View {
    HStack(spacing: 14) {
      StatusBadge(status: .running, compact: true)

      VStack(alignment: .leading, spacing: 3) {
        Text("Local Operator Dock workspace")
          .font(.odText(13.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text("Workspace writes are bounded; outside mutations require approval.")
          .font(.odText(11.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
      }

      Spacer()

      WorkspaceMetric(label: "Boundary", value: "On")
      WorkspaceMetric(label: "Logs", value: "Raw")
      WorkspaceMetric(label: "Events", value: "Live")

      Button {
        if !store.pendingApprovals.isEmpty {
          showApproval = true
        }
      } label: {
        Label("\(store.pendingApprovals.count) pending", systemImage: "checkmark.shield")
          .font(.odText(11.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.waiting)
          .frame(height: 24)
          .padding(.horizontal, 9)
          .background(ODTheme.ColorToken.waiting.opacity(0.12))
          .clipShape(Capsule())
      }
      .buttonStyle(.plain)
      .disabled(store.pendingApprovals.isEmpty)

      PillButton(title: "", systemImage: "pause", style: .secondary) {}
      PillButton(title: "", systemImage: "stop.fill", style: .secondary) {}
    }
    .frame(height: 56)
    .padding(.horizontal, ODTheme.Space.page)
    .padding(.top, 32)
  }

  private var leftPane: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionLabel(title: "Workspace folders")

      VStack(spacing: 8) {
        WorkspaceFolderRow(title: "Projects", path: store.workspace?.folders.projects)
        WorkspaceFolderRow(title: "Tasks", path: store.workspace?.folders.tasks)
        WorkspaceFolderRow(title: "Artifacts", path: store.workspace?.folders.artifacts)
        WorkspaceFolderRow(title: "Logs", path: store.workspace?.folders.logs)
        WorkspaceFolderRow(title: "Skills", path: store.workspace?.folders.skills)
        WorkspaceFolderRow(title: "Memory", path: store.workspace?.folders.memory)
      }
      .padding(14)
      .odCard()

      SectionLabel(title: "Safety")
      VStack(alignment: .leading, spacing: 10) {
        Label("Writes default to workspace only", systemImage: "lock.shield")
        Label("Deletes outside workspace require approval", systemImage: "checkmark.shield")
        Label("System directory deletion is blocked", systemImage: "nosign")
      }
      .font(.odText(11.5, weight: .medium))
      .foregroundStyle(ODTheme.ColorToken.textSecondary)
      .padding(14)
      .odCard()
    }
  }

  private var inspectorPane: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        SectionLabel(title: "Current tool")
        ForEach(SampleData.tools) { tool in
          ToolCallCard(tool: tool)
        }

        SectionLabel(title: "Approvals", count: "\(store.pendingApprovals.count)")
        if let approval = store.pendingApprovals.first {
          Button {
            showApproval = true
          } label: {
            HStack {
              Label(approval.toolName, systemImage: "checkmark.shield")
                .font(.odText(12.5, weight: .medium))
              Spacer()
              Text(approval.riskLevel.displayName)
                .font(.odText(11.5, weight: .medium))
            }
            .foregroundStyle(ODTheme.ColorToken.waiting)
            .padding(14)
            .odCard(fill: ODTheme.ColorToken.waiting.opacity(0.09))
          }
          .buttonStyle(.plain)
        } else {
          HStack {
            Label("No pending approvals", systemImage: "checkmark.shield")
              .font(.odText(12.5, weight: .medium))
            Spacer()
          }
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
          .padding(14)
          .odCard(fill: ODTheme.ColorToken.surface)
        }

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

private struct FileExplorerPanel: View {
  @Bindable var store: AppStore

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        WorkspaceSegment(title: "Files", active: true)
        Spacer()
        PillButton(title: "Root", systemImage: "arrow.up.left", style: .secondary) {
          Task {
            await store.goToWorkspaceRoot()
          }
        }
        PillButton(title: "Choose workspace", systemImage: "folder.badge.gearshape", style: .primary) {
          chooseWorkspace()
        }
      }

      VStack(alignment: .leading, spacing: 14) {
        workspaceHeader

        Divider()
          .overlay(ODTheme.ColorToken.border)

        if store.workspace == nil {
          VStack(spacing: 12) {
            Image(systemName: "folder.badge.questionmark")
              .font(.system(size: 34, weight: .medium))
              .foregroundStyle(ODTheme.ColorToken.textMuted)

            Text("Choose an Operator Dock workspace folder")
              .font(.odText(14, weight: .semibold))
              .foregroundStyle(ODTheme.ColorToken.textPrimary)

            Text("Operator Dock will create projects, tasks, artifacts, logs, skills, and memory folders inside it.")
              .font(.odText(12))
              .foregroundStyle(ODTheme.ColorToken.textTertiary)
              .multilineTextAlignment(.center)

            PillButton(title: "Choose folder", systemImage: "folder", style: .primary) {
              chooseWorkspace()
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(32)
        } else {
          fileList
        }
      }
      .padding(18)
      .odCard(fill: ODTheme.ColorToken.surface)
    }
    .task {
      await store.refreshWorkspace()
    }
  }

  private var workspaceHeader: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(store.fileExplorerPath == "." ? "Workspace root" : store.fileExplorerPath)
          .font(.odText(15, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text(store.workspace?.rootPath ?? "No workspace configured")
          .font(.odMono(11.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
          .lineLimit(1)
      }

      Spacer()

      if let workspace = store.workspace {
        Text(workspace.initialized ? "Initialized" : "Not initialized")
          .font(.odText(11.5, weight: .medium))
          .foregroundStyle(workspace.initialized ? ODTheme.ColorToken.success : ODTheme.ColorToken.waiting)
          .padding(.horizontal, 9)
          .frame(height: 24)
          .background((workspace.initialized ? ODTheme.ColorToken.success : ODTheme.ColorToken.waiting).opacity(0.12))
          .clipShape(Capsule())
      }
    }
  }

  private var fileList: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Name")
          .frame(maxWidth: .infinity, alignment: .leading)
        Text("Kind")
          .frame(width: 90, alignment: .leading)
        Text("Size")
          .frame(width: 90, alignment: .trailing)
      }
      .font(.odText(11, weight: .semibold))
      .foregroundStyle(ODTheme.ColorToken.textMuted)
      .textCase(.uppercase)
      .padding(.horizontal, 12)
      .padding(.bottom, 8)

      ScrollView {
        VStack(spacing: 4) {
          ForEach(store.workspaceFiles) { entry in
            FileExplorerRow(entry: entry) {
              Task {
                await store.openFileExplorerFolder(entry)
              }
            }
          }
        }
      }
    }
  }

  private func chooseWorkspace() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = "Choose Workspace"
    panel.message = "Choose the folder where Operator Dock should manage local projects, tasks, artifacts, logs, skills, and memory."

    if panel.runModal() == .OK, let url = panel.url {
      Task {
        await store.configureWorkspace(rootPath: url.path)
      }
    }
  }
}

private struct WorkspaceFolderRow: View {
  let title: String
  let path: String?

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "folder")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.accent)
        .frame(width: 18)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.odText(12, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)

        Text(path ?? "Not configured")
          .font(.odMono(10.5))
          .foregroundStyle(ODTheme.ColorToken.textMuted)
          .lineLimit(1)
      }

      Spacer()
    }
  }
}

private struct FileExplorerRow: View {
  let entry: FileEntry
  let open: () -> Void

  var body: some View {
    Button(action: open) {
      HStack(spacing: 12) {
        Image(systemName: entry.kind == .directory ? "folder" : "doc.text")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(entry.kind == .directory ? ODTheme.ColorToken.accent : ODTheme.ColorToken.textTertiary)
          .frame(width: 20)

        VStack(alignment: .leading, spacing: 3) {
          Text(entry.name)
            .font(.odText(12.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
            .lineLimit(1)

          Text(entry.relativePath)
            .font(.odText(10.5))
            .foregroundStyle(ODTheme.ColorToken.textMuted)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        Text(entry.kind.rawValue)
          .font(.odText(11.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
          .frame(width: 90, alignment: .leading)

        Text(fileSize)
          .font(.odMono(11))
          .foregroundStyle(ODTheme.ColorToken.textMuted)
          .frame(width: 90, alignment: .trailing)
      }
      .padding(.horizontal, 12)
      .frame(height: 48)
      .background(ODTheme.ColorToken.canvas.opacity(0.35))
      .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(entry.kind != .directory)
  }

  private var fileSize: String {
    guard let size = entry.size else {
      return "-"
    }

    if size < 1024 {
      return "\(size) B"
    }

    return "\(size / 1024) KB"
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
