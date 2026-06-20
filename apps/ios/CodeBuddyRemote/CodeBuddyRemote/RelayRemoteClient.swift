import Foundation

enum RelayClientError: LocalizedError {
  case invalidRelayURL
  case invalidPairingCode
  case notConnected
  case malformedFrame
  case relayError(String)

  var errorDescription: String? {
    switch self {
    case .invalidRelayURL:
      "请输入有效的 Relay 地址"
    case .invalidPairingCode:
      "请输入配对码"
    case .notConnected:
      "Relay 尚未连接"
    case .malformedFrame:
      "无法解析 Relay 消息"
    case .relayError(let message):
      message
    }
  }
}

@MainActor
final class RelayRemoteClient {
  private let config: RelayConfig
  private let session: URLSession
  private var task: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var eventContinuation: AsyncThrowingStream<RemoteEvent, Error>.Continuation?
  private var eventBacklog: [RemoteEvent] = []
  private var joinContinuation: CheckedContinuation<Void, Error>?
  private var pendingResponses: [String: (Result<Data, Error>) -> Void] = [:]

  init(config: RelayConfig, session: URLSession = .shared) {
    self.config = config
    self.session = session
  }

  func connect() async throws {
    guard let url = config.normalizedRelayURL else {
      throw RelayClientError.invalidRelayURL
    }
    let pairingCode = config.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !pairingCode.isEmpty else {
      throw RelayClientError.invalidPairingCode
    }

    task?.cancel(with: .goingAway, reason: nil)
    let socket = session.webSocketTask(with: url)
    task = socket
    socket.resume()

    receiveTask = Task { [weak self] in
      await self?.receiveLoop()
    }

    try await withCheckedThrowingContinuation { continuation in
      joinContinuation = continuation
      Task {
        do {
          try await send([
            "type": "client.join",
            "pairingCode": pairingCode,
            "pairingSecret": config.pairingSecret,
          ])
        } catch {
          resumeJoin(throwing: error)
        }
      }
    }
  }

  func disconnect() {
    receiveTask?.cancel()
    receiveTask = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    eventContinuation?.finish()
    eventContinuation = nil
    eventBacklog.removeAll()

    for respond in pendingResponses.values {
      respond(.failure(CancellationError()))
    }
    pendingResponses.removeAll()
  }

  func listSessions() async throws -> [RemoteSession] {
    let response: SessionListResponse = try await request(
      name: "listSessions",
      sessionId: "local-host",
      payload: [:]
    )
    return response.sessions
  }

  func listEvents(after: Int = 0, before: Int = 0, limit: Int = 0) async throws -> EventListResponse {
    var payload = ["after": String(after)]
    if before > 0 {
      payload["before"] = String(before)
    }
    if limit > 0 {
      payload["limit"] = String(limit)
    }
    let response: EventListResponse = try await request(
      name: "listEvents",
      sessionId: "local-host",
      payload: payload
    )
    return response
  }

  func sendPrompt(sessionId: String, text: String) async throws {
    let _: CommandEnvelope = try await request(
      name: "sendPrompt",
      sessionId: sessionId,
      payload: ["text": text]
    )
  }

  func sendTerminalInput(sessionId: String, text: String, label: String) async throws {
    let _: CommandEnvelope = try await request(
      name: "sendTerminalInput",
      sessionId: sessionId,
      payload: ["text": text, "label": label]
    )
  }

  func interrupt(sessionId: String) async throws {
    let _: CommandEnvelope = try await request(
      name: "interrupt",
      sessionId: sessionId,
      payload: [:]
    )
  }

  func resume(sessionId: String) async throws {
    let _: CommandEnvelope = try await request(
      name: "resume",
      sessionId: sessionId,
      payload: [:]
    )
  }

  func streamEvents() -> AsyncThrowingStream<RemoteEvent, Error> {
    AsyncThrowingStream { continuation in
      eventContinuation = continuation
      for event in eventBacklog {
        continuation.yield(event)
      }
      eventBacklog.removeAll()
      continuation.onTermination = { [weak self] _ in
        Task { @MainActor in
          self?.eventContinuation = nil
        }
      }
    }
  }

  private func request<T: Decodable>(
    name: String,
    sessionId: String,
    payload: [String: String]
  ) async throws -> T {
    let commandId = "cmd_ios_\(UUID().uuidString)"
    let command: [String: Any] = [
      "type": "command",
      "id": commandId,
      "sessionId": sessionId,
      "name": name,
      "payload": payload,
    ]

    return try await withCheckedThrowingContinuation { continuation in
      pendingResponses[commandId] = { result in
        switch result {
        case .success(let data):
          do {
            continuation.resume(returning: try JSONDecoder().decode(T.self, from: data))
          } catch {
            continuation.resume(throwing: error)
          }
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }

      Task {
        do {
          try await send([
            "type": "frame",
            "payload": command,
          ])
        } catch {
          let respond = pendingResponses.removeValue(forKey: commandId)
          respond?(.failure(error))
        }
      }

      Task {
        try? await Task.sleep(nanoseconds: 10_000_000_000)
        let respond = pendingResponses.removeValue(forKey: commandId)
        respond?(.failure(RelayClientError.relayError("Relay 请求超时")))
      }
    }
  }

  private func receiveLoop() async {
    do {
      while !Task.isCancelled {
        guard let task else { return }
        let message = try await task.receive()
        try handle(message)
      }
    } catch {
      eventContinuation?.finish(throwing: error)
      resumeJoin(throwing: error)
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) throws {
    let data: Data
    switch message {
    case .string(let text):
      data = Data(text.utf8)
    case .data(let payload):
      data = payload
    @unknown default:
      throw RelayClientError.malformedFrame
    }

    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = root["type"] as? String
    else {
      throw RelayClientError.malformedFrame
    }

    switch type {
    case "client.joined":
      resumeJoin()
    case "error":
      let message = root["error"] as? String ?? "Relay 返回错误"
      throw RelayClientError.relayError(message)
    case "frame":
      try handlePayload(root["payload"])
    default:
      break
    }
  }

  private func handlePayload(_ value: Any?) throws {
    guard let payload = value as? [String: Any], let type = payload["type"] as? String else {
      throw RelayClientError.malformedFrame
    }

    let data = try JSONSerialization.data(withJSONObject: payload)
    if type == "event" {
      let event = try JSONDecoder().decode(RemoteEvent.self, from: data)
      if let eventContinuation {
        eventContinuation.yield(event)
      } else {
        eventBacklog.append(event)
        if eventBacklog.count > 200 {
          eventBacklog.removeFirst(eventBacklog.count - 200)
        }
      }
      return
    }

    if type == "response" {
      guard let requestId = payload["requestId"] as? String else {
        throw RelayClientError.malformedFrame
      }
      let respond = pendingResponses.removeValue(forKey: requestId)
      let ok = payload["ok"] as? Bool ?? false
      if !ok {
        respond?(.failure(RelayClientError.relayError(payload["error"] as? String ?? "请求失败")))
        return
      }
      let body = payload["body"] as? [String: Any] ?? [:]
      respond?(.success(try JSONSerialization.data(withJSONObject: body)))
    }
  }

  private func send(_ dictionary: [String: Any]) async throws {
    guard let task else {
      throw RelayClientError.notConnected
    }
    let data = try JSONSerialization.data(withJSONObject: dictionary)
    guard let text = String(data: data, encoding: .utf8) else {
      throw RelayClientError.malformedFrame
    }
    try await task.send(.string(text))
  }

  private func resumeJoin(throwing error: Error? = nil) {
    guard let continuation = joinContinuation else { return }
    joinContinuation = nil
    if let error {
      continuation.resume(throwing: error)
    } else {
      continuation.resume()
    }
  }
}
