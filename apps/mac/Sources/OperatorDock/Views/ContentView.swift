import SwiftUI

struct ContentView: View {
  @Bindable var store: AppStore

  var body: some View {
    NavigationSplitView {
      SidebarView(selection: $store.selectedSection)
    } detail: {
      DetailView(store: store)
    }
    .onAppear {
      store.start()
    }
  }
}

