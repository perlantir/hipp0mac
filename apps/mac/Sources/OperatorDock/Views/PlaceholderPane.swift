import SwiftUI

struct PlaceholderPane: View {
  let title: String
  let systemImage: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.system(size: 42))
        .foregroundStyle(.secondary)

      Text(title)
        .font(.title2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .navigationTitle(title)
  }
}

