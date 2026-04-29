import SwiftUI

struct SidebarView: View {
  @Bindable var store: AppStore

  var body: some View {
    VStack(spacing: 0) {
      brand

      Button {
        store.selectedSection = .home
      } label: {
        HStack(spacing: 10) {
          Image(systemName: "plus")
            .font(.system(size: 14, weight: .semibold))

          Text("New task")
            .font(.odText(13.5, weight: .medium))

          Spacer()

          Text("Cmd K")
            .font(.odMono(10.5))
            .foregroundStyle(ODTheme.ColorToken.textMuted)
        }
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
        .frame(height: 38)
        .padding(.horizontal, 14)
        .background(ODTheme.ColorToken.surface)
        .clipShape(RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: ODTheme.Radius.lg, style: .continuous)
            .stroke(ODTheme.ColorToken.border, lineWidth: 1)
        )
      }
      .buttonStyle(.plain)
      .padding(.horizontal, 16)
      .padding(.bottom, 16)

      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ForEach(SidebarGroup.defaultGroups) { group in
            VStack(alignment: .leading, spacing: 4) {
              if let title = group.title {
                Text(title)
                  .font(.odText(11, weight: .medium))
                  .foregroundStyle(ODTheme.ColorToken.textMuted)
                  .textCase(.uppercase)
                  .padding(.horizontal, 24)
                  .padding(.bottom, 4)
              }

              ForEach(group.sections) { section in
                SidebarItem(
                  section: section,
                  isActive: store.selectedSection == section
                ) {
                  store.selectedSection = section
                }
                .padding(.horizontal, 10)
              }
            }
          }

          VStack(alignment: .leading, spacing: 4) {
            Text("Pinned")
              .font(.odText(11, weight: .medium))
              .foregroundStyle(ODTheme.ColorToken.textMuted)
              .textCase(.uppercase)
              .padding(.horizontal, 24)
              .padding(.bottom, 4)

            PinnedRow(title: "Q3 competitive scan")
            PinnedRow(title: "Pricing model v4")
            PinnedRow(title: "Onboarding rewrite")
          }
        }
        .padding(.vertical, 4)
      }

      Spacer(minLength: 0)

      profile
    }
    .background(ODTheme.ColorToken.sidebar)
  }

  private var brand: some View {
    HStack(spacing: 10) {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(ODTheme.ColorToken.accent)
        .frame(width: 26, height: 26)
        .overlay {
          Image(systemName: "dock.rectangle")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)
        }

      Text("Operator Dock")
        .font(.odText(15, weight: .semibold))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)

      Spacer()
    }
    .padding(.top, 52)
    .padding(.horizontal, 24)
    .padding(.bottom, 22)
  }

  private var profile: some View {
    VStack(spacing: 14) {
      Button {} label: {
        Text("Upgrade to Pro")
          .font(.odText(13.5, weight: .medium))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
          .frame(maxWidth: .infinity)
          .frame(height: 44)
          .background(ODTheme.ColorToken.accent)
          .clipShape(Capsule())
      }
      .buttonStyle(.plain)

      HStack(spacing: 10) {
        Text("R")
          .font(.odText(11, weight: .semibold))
          .foregroundStyle(ODTheme.ColorToken.textPrimary)
          .frame(width: 26, height: 26)
          .background(ODTheme.ColorToken.accent)
          .clipShape(Circle())

        VStack(alignment: .leading, spacing: 2) {
          Text("Rae Chen")
            .font(.odText(12.5, weight: .medium))
            .foregroundStyle(ODTheme.ColorToken.textPrimary)

          Text("1,420 credits")
            .font(.odText(11))
            .foregroundStyle(ODTheme.ColorToken.textMuted)
        }

        Spacer()
      }
      .padding(.horizontal, 6)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 18)
  }
}

private struct PinnedRow: View {
  let title: String

  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(ODTheme.ColorToken.textMuted)
        .frame(width: 5, height: 5)

      Text(title)
        .font(.odText(13))
        .foregroundStyle(ODTheme.ColorToken.textTertiary)
        .lineLimit(1)

      Spacer()
    }
    .frame(height: 30)
    .padding(.horizontal, 24)
  }
}

