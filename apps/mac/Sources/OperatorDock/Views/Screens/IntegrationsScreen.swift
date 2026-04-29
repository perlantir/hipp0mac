import SwiftUI

struct IntegrationsScreen: View {
  var body: some View {
    VStack(spacing: 0) {
      ScreenHeader(
        title: "Integrations",
        subtitle: "Connected tools and available local capabilities."
      ) {
        PillButton(title: "Connect", systemImage: "plus", style: .primary) {}
      }

      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          SectionLabel(title: "Connected", count: "4")

          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 2), spacing: 12) {
            ForEach(SampleData.integrations) { integration in
              IntegrationCard(integration: integration)
            }
          }

          SectionLabel(title: "Available")

          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 12) {
            ForEach(["Slack", "Google Drive", "Figma", "Jira", "Mixpanel", "Vercel", "Cloudflare", "GitLab"], id: \.self) { name in
              VStack(spacing: 14) {
                LetterAvatar(text: name, color: ODTheme.ColorToken.subtle)
                Text(name)
                  .font(.odText(12.5, weight: .medium))
                  .foregroundStyle(ODTheme.ColorToken.textPrimary)
                Text("Connect")
                  .font(.odText(11.5, weight: .medium))
                  .foregroundStyle(ODTheme.ColorToken.accent)
              }
              .frame(maxWidth: .infinity)
              .padding(16)
              .odCard()
            }
          }
        }
        .padding(.horizontal, ODTheme.Space.page)
        .padding(.bottom, ODTheme.Space.page)
      }
    }
    .background(ODTheme.ColorToken.canvas)
  }
}

