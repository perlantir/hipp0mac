import SwiftUI

struct ArtifactsScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Artifacts",
        subtitle: "Files, logs, reports, screenshots, and run outputs."
      ) {
        PillButton(title: "Reveal workspace", systemImage: "folder", style: .secondary) {}
      }

      VStack(alignment: .leading, spacing: 12) {
        SectionLabel(title: "Recent artifacts", count: "\(SampleData.artifacts.count)")
        ForEach(SampleData.artifacts) { artifact in
          ArtifactCard(artifact: artifact)
        }
      }
      .padding(.horizontal, ODTheme.Space.page)

      Spacer()
    }
    .background(ODTheme.ColorToken.canvas)
  }
}

