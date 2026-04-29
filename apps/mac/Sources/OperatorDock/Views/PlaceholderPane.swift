import SwiftUI

struct PlaceholderPane: View {
  let title: String
  let systemImage: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.system(size: 42))
        .foregroundStyle(ODTheme.ColorToken.textMuted)

      Text(title)
        .font(.odDisplay(22, weight: .medium))
        .foregroundStyle(ODTheme.ColorToken.textPrimary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ODTheme.ColorToken.canvas)
  }
}

