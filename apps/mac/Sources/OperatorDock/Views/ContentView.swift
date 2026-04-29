import SwiftUI

struct ContentView: View {
  @Bindable var store: AppStore

  var body: some View {
    HStack(spacing: 0) {
      SidebarView(store: store)
        .frame(width: 244)

      Divider()
        .overlay(ODTheme.ColorToken.border)

      DetailView(store: store)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ODTheme.ColorToken.canvas)
    }
    .background(ODTheme.ColorToken.canvas)
    .preferredColorScheme(.dark)
    .onAppear {
      store.start()
    }
  }
}

