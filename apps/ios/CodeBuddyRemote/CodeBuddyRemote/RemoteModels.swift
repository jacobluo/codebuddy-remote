import Foundation

struct RemoteConfig: Equatable {
  var baseURL: String
  var token: String

  static let defaultValue = RemoteConfig(
    baseURL: "http://127.0.0.1:17320",
    token: "dev-token"
  )

  var normalizedBaseURL: URL? {
    let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
      return URL(string: trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
    return URL(string: "http://\(trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/")))")
  }
}

struct RemoteSession: Codable, Identifiable, Equatable {
  let id: String
  let source: String
  let workspace: String
  let state: String
}

struct SessionListResponse: Codable {
  let sessions: [RemoteSession]
}

struct RemoteEvent: Codable, Identifiable, Equatable {
  let id: String
  let sessionId: String
  let seq: Int
  let name: String
  let conversationId: String?
  let payload: EventPayload
}

struct EventPayload: Codable, Equatable {
  let text: String?
  let status: String?
}

struct CommandEnvelope: Codable {
  let command: RemoteCommand
}

struct RemoteCommand: Codable {
  let id: String
  let sessionId: String
  let name: String
}

struct StateEnvelope: Codable {
  let state: SessionState
}

struct SessionState: Codable, Equatable {
  let sessionId: String
  let source: String
  let workspace: String
  let status: String
  let conversationId: String?
}
