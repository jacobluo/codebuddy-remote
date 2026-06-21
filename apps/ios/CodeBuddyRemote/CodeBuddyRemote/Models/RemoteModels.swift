import Foundation

struct RelayConfig: Equatable {
  var relayURL: String
  var pairingCode: String
  var pairingSecret: String
  var token: String

  static let defaultValue = RelayConfig(
    relayURL: "ws://127.0.0.1:17330/relay",
    pairingCode: "",
    pairingSecret: "",
    token: ""
  )

  var normalizedRelayURL: URL? {
    let trimmed = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let withScheme: String
    if trimmed.hasPrefix("ws://") || trimmed.hasPrefix("wss://") {
      withScheme = trimmed
    } else if trimmed.hasPrefix("http://") {
      withScheme = "ws://" + trimmed.dropFirst("http://".count)
    } else if trimmed.hasPrefix("https://") {
      withScheme = "wss://" + trimmed.dropFirst("https://".count)
    } else {
      withScheme = "wss://\(trimmed)"
    }

    return URL(string: String(withScheme))
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

struct EventListResponse: Codable {
  let events: [RemoteEvent]
  let latestSeq: Int
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
  let kind: String?
  let title: String?
  let toolName: String?
  let command: String?
  let target: String?
  let additions: Int?
  let deletions: Int?
}

struct CommandEnvelope: Codable {
  let command: RemoteCommand
}

struct RemoteCommand: Codable {
  let id: String
  let sessionId: String
  let name: String
  let payload: EventPayload?
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
