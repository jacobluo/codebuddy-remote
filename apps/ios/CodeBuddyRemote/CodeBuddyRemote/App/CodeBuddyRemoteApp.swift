import SwiftUI

@main
struct CodeBuddyRemoteApp: App {
  @State private var appState = AppState()

  var body: some Scene {
    WindowGroup {
      AppView()
        .environment(appState)
        .onOpenURL { url in
          appState.handleOpenURL(url)
        }
    }
  }
}
