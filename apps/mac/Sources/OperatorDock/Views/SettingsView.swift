import SwiftUI

struct SettingsView: View {
  let store: AppStore

  var body: some View {
    Form {
      Section("Daemon") {
        LabeledContent("Status", value: store.connectionState.rawValue)

        if let health = store.health {
          LabeledContent("Service", value: health.service)
          LabeledContent("Version", value: health.version)
        }
      }
    }
    .formStyle(.grouped)
    .padding()
    .frame(minWidth: 420, minHeight: 220)
    .navigationTitle("Settings")
  }
}

