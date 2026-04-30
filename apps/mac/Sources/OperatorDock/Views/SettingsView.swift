import AppKit
import SwiftUI
import OperatorDockCore

struct SettingsView: View {
  @Bindable var store: AppStore

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      settingsNav
        .frame(width: 220)

      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          ScreenHeader(
            title: "Settings",
            subtitle: "Provider setup, daemon health, defaults, and local security."
          ) {
            PillButton(title: "Refresh", systemImage: "arrow.clockwise", style: .secondary) {
              Task {
                await store.refreshHealth()
                await store.refreshProviders()
              }
            }
          }
          .padding(.horizontal, 0)
          .padding(.top, 0)

          daemonPanel
          providerPanel
          defaultsPanel
        }
        .padding(ODTheme.Space.page)
      }
    }
    .background(ODTheme.ColorToken.canvas)
    .task {
      await store.refreshProviders()
    }
  }

  private var settingsNav: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Settings")
        .font(.odText(11, weight: .semibold))
        .foregroundStyle(ODTheme.ColorToken.textMuted)
        .textCase(.uppercase)
        .padding(.horizontal, 20)
        .padding(.top, 42)

      SettingsNavItem(title: "Profile", systemImage: "person.crop.circle")
      SettingsNavItem(title: "Providers", systemImage: "cpu", active: true)
      SettingsNavItem(title: "Defaults", systemImage: "slider.horizontal.3")
      SettingsNavItem(title: "Security", systemImage: "lock.shield")

      Spacer()
    }
    .background(ODTheme.ColorToken.sidebar.opacity(0.55))
  }

  private var daemonPanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionLabel(title: "Daemon")

      HStack(spacing: 16) {
        StatusBadge(status: daemonStatusBadge)

        VStack(alignment: .leading, spacing: 4) {
          Text(store.health?.state.displayName ?? store.connectionState.rawValue)
            .font(.odText(13.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)

          Text(store.health?.service ?? "operator-dock-daemon")
            .font(.odText(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
        }

        Spacer()

        if let health = store.health {
          Text(health.version)
            .font(.odMono(11.5))
            .foregroundStyle(ODTheme.ColorToken.textSecondary)
        }
      }
      .padding(16)
      .odCard()

      if let supervisorError = store.daemonSupervisorError {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "exclamationmark.triangle")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ODTheme.ColorToken.waiting)
            .frame(width: 22)

          Text(supervisorError)
            .font(.odText(12.5))
            .foregroundStyle(ODTheme.ColorToken.textSecondary)

          Spacer()
        }
        .padding(16)
        .odCard()
      }

      HStack(spacing: 12) {
        Image(systemName: "doc.text.magnifyingglass")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textSecondary)
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 4) {
          Text("Daemon log")
            .font(.odText(12.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
          Text(store.daemonLogPath)
            .font(.odMono(11))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
            .lineLimit(2)
            .textSelection(.enabled)
        }

        Spacer()

        Button {
          NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: store.daemonLogPath)])
        } label: {
          Image(systemName: "arrow.up.right.square")
        }
        .buttonStyle(.plain)
        .foregroundStyle(ODTheme.ColorToken.textSecondary)
        .help("Reveal daemon log")
      }
      .padding(16)
      .odCard()
    }
  }

  private var daemonStatusBadge: WorkStatus {
    guard store.connectionState == .connected else {
      return .waiting
    }

    return store.health?.state == .ready ? .success : .waiting
  }

  private var providerPanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionLabel(title: "Providers", count: "\(store.providers.count)")

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 2), spacing: 12) {
        ForEach(store.providers) { provider in
          ProviderSettingsCard(
            provider: provider,
            result: store.providerTestResults[provider.id],
            onSaveCredential: { apiKey in
              Task {
                await store.saveProviderAPIKey(providerId: provider.id, apiKey: apiKey)
              }
            },
            onSaveConfig: { enabled, endpoint, defaultModel in
              Task {
                await store.updateProvider(
                  providerId: provider.id,
                  enabled: enabled,
                  endpoint: endpoint,
                  defaultModel: defaultModel
                )
              }
            },
            onTest: {
              Task {
                await store.testProvider(providerId: provider.id)
              }
            }
          )
        }
      }

      if store.providers.isEmpty {
        Text("Start the local daemon to load provider configuration.")
          .font(.odText(12.5))
          .foregroundStyle(ODTheme.ColorToken.textTertiary)
          .padding(16)
          .odCard()
      }
    }
  }

  private var defaultsPanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      SectionLabel(title: "Model defaults")

      VStack(spacing: 10) {
        DefaultsRow(title: "Planner", value: store.routerConfig?.purposeDefaults.planner ?? "Auto")
        DefaultsRow(title: "Executor", value: store.routerConfig?.purposeDefaults.executor ?? "Auto")
        DefaultsRow(title: "Verifier", value: store.routerConfig?.purposeDefaults.verifier ?? "Auto")
        DefaultsRow(title: "Summarizer", value: store.routerConfig?.purposeDefaults.summarizer ?? "Auto")
        DefaultsRow(title: "Memory curator", value: store.routerConfig?.purposeDefaults.memoryCurator ?? "Auto")
      }
      .padding(16)
      .odCard()
    }
  }
}

private struct SettingsNavItem: View {
  let title: String
  let systemImage: String
  var active = false

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: systemImage)
        .font(.system(size: 13, weight: .medium))
        .frame(width: 18)
      Text(title)
        .font(.odText(13, weight: active ? .medium : .regular))
      Spacer()
    }
    .foregroundStyle(active ? ODTheme.ColorToken.textPrimary : ODTheme.ColorToken.textTertiary)
    .frame(height: 34)
    .padding(.horizontal, 14)
    .background(active ? ODTheme.ColorToken.surfaceRaised : Color.clear)
    .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))
    .padding(.horizontal, 10)
  }
}

private struct ProviderSettingsCard: View {
  let provider: ProviderConfig
  let result: ProviderConnectionTestResponse?
  let onSaveCredential: (String) -> Void
  let onSaveConfig: (Bool, String?, String?) -> Void
  let onTest: () -> Void

  @State private var enabled: Bool
  @State private var endpoint: String
  @State private var defaultModel: String
  @State private var apiKey = ""

  init(
    provider: ProviderConfig,
    result: ProviderConnectionTestResponse?,
    onSaveCredential: @escaping (String) -> Void,
    onSaveConfig: @escaping (Bool, String?, String?) -> Void,
    onTest: @escaping () -> Void
  ) {
    self.provider = provider
    self.result = result
    self.onSaveCredential = onSaveCredential
    self.onSaveConfig = onSaveConfig
    self.onTest = onTest
    _enabled = State(initialValue: provider.enabled)
    _endpoint = State(initialValue: provider.endpoint ?? "")
    _defaultModel = State(initialValue: provider.defaultModel ?? "")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        LetterAvatar(text: provider.displayName, color: provider.kind == .hosted ? ODTheme.ColorToken.accent : ODTheme.ColorToken.success)

        VStack(alignment: .leading, spacing: 3) {
          Text(provider.displayName)
            .font(.odText(14, weight: .semibold))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)

          Text(provider.kind == .hosted ? "Hosted API" : "Local endpoint")
            .font(.odText(11.5))
            .foregroundStyle(ODTheme.ColorToken.textTertiary)
        }

        Spacer()

        Toggle("", isOn: $enabled)
          .toggleStyle(.switch)
          .labelsHidden()
      }

      VStack(alignment: .leading, spacing: 10) {
        if provider.kind == .hosted {
          HStack {
            Label(provider.apiKeyConfigured ? "API key configured" : "API key missing", systemImage: provider.apiKeyConfigured ? "checkmark.seal.fill" : "exclamationmark.triangle")
              .font(.odText(11.5, weight: .medium))
              .foregroundStyle(provider.apiKeyConfigured ? ODTheme.ColorToken.success : ODTheme.ColorToken.waiting)
            Spacer()
          }

          SecureField("Paste API key", text: $apiKey)
            .textFieldStyle(.plain)
            .font(.odText(12.5))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
            .padding(10)
            .background(ODTheme.ColorToken.canvas)
            .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: ODTheme.Radius.md, style: .continuous).stroke(ODTheme.ColorToken.border, lineWidth: 1))
        } else {
          SettingsTextField(title: "Endpoint", text: $endpoint)
        }

        SettingsTextField(title: "Default model", text: $defaultModel)
      }

      CapabilityRow(models: provider.models)

      if let result {
        Text(result.message)
          .font(.odText(11.5))
          .foregroundStyle(result.ok ? ODTheme.ColorToken.success : ODTheme.ColorToken.waiting)
          .lineLimit(2)
      }

      HStack(spacing: 8) {
        if provider.kind == .hosted {
          PillButton(title: "Save key", systemImage: "key", style: .secondary) {
            onSaveCredential(apiKey)
            apiKey = ""
          }
        }

        PillButton(title: "Save config", systemImage: "checkmark", style: .secondary) {
          onSaveConfig(
            enabled,
            provider.kind == .local ? endpoint : nil,
            defaultModel.isEmpty ? nil : defaultModel
          )
        }

        Spacer()

        PillButton(title: "Test", systemImage: "antenna.radiowaves.left.and.right", style: .primary, action: onTest)
      }
    }
    .padding(18)
    .odCard()
  }
}

private struct SettingsTextField: View {
  let title: String
  @Binding var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.odText(10.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textMuted)
        .textCase(.uppercase)

      TextField(title, text: $text)
        .textFieldStyle(.plain)
        .font(.odText(12.5))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
        .padding(10)
        .background(ODTheme.ColorToken.canvas)
        .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: ODTheme.Radius.md, style: .continuous).stroke(ODTheme.ColorToken.border, lineWidth: 1))
    }
  }
}

private struct CapabilityRow: View {
  let models: [ProviderModel]

  var body: some View {
    HStack(spacing: 6) {
      capability("Streaming", enabled: models.contains { $0.capabilities.streaming })
      capability("Tools", enabled: models.contains { $0.capabilities.tools })
      capability("Vision", enabled: models.contains { $0.capabilities.vision })
      Spacer()
    }
  }

  private func capability(_ title: String, enabled: Bool) -> some View {
    Text(title)
      .font(.odText(10.5, weight: .medium))
      .foregroundStyle(enabled ? ODTheme.ColorToken.textSecondary : ODTheme.ColorToken.textMuted)
      .padding(.horizontal, 8)
      .frame(height: 22)
      .background(enabled ? ODTheme.ColorToken.surfaceRaised : ODTheme.ColorToken.canvas)
      .clipShape(Capsule())
      .overlay(Capsule().stroke(ODTheme.ColorToken.border, lineWidth: 1))
  }
}

private struct DefaultsRow: View {
  let title: String
  let value: String

  var body: some View {
    HStack {
      Text(title)
        .font(.odText(12.5, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textSecondary)

      Spacer()

      Text(value)
        .font(.odMono(11.5))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
        .padding(.horizontal, 9)
        .frame(height: 24)
        .background(ODTheme.ColorToken.canvas)
        .clipShape(Capsule())
    }
  }
}
