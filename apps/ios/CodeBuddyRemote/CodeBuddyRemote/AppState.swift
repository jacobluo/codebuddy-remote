import Foundation
import Observation

@MainActor
@Observable
final class AppState {
  var pendingPairingCode: String?

  func handleOpenURL(_ url: URL) {
    guard url.scheme == "cbr", url.host == "pair" else { return }
    pendingPairingCode = url.absoluteString
  }
}
