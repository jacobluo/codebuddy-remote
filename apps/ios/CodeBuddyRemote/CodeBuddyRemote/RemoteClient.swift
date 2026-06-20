import Foundation

enum RemoteClientError: LocalizedError {
  case invalidBaseURL
  case badStatus(Int)
  case malformedEvent

  var errorDescription: String? {
    switch self {
    case .invalidBaseURL:
      "请输入有效的 Mac 地址"
    case .badStatus(let status):
      "请求失败：HTTP \(status)"
    case .malformedEvent:
      "无法解析事件流"
    }
  }
}

struct RemoteClient {
  var config: RemoteConfig
  var session: URLSession = .shared

  func listSessions() async throws -> [RemoteSession] {
    let response: SessionListResponse = try await get("/api/sessions")
    return response.sessions
  }

  func sendPrompt(sessionId: String, text: String) async throws {
    let _: CommandEnvelope = try await post(
      "/api/sessions/\(sessionId)/messages",
      body: ["text": text]
    )
  }

  func interrupt(sessionId: String) async throws {
    let _: CommandEnvelope = try await post(
      "/api/sessions/\(sessionId)/interrupt",
      body: [:]
    )
  }

  func resume(sessionId: String) async throws {
    let _: CommandEnvelope = try await post(
      "/api/sessions/\(sessionId)/resume",
      body: [:]
    )
  }

  func streamEvents(after: Int = 0) -> AsyncThrowingStream<RemoteEvent, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let url = try endpoint("/api/events/stream", query: [
            URLQueryItem(name: "token", value: config.token),
            URLQueryItem(name: "after", value: String(after)),
          ])
          var request = URLRequest(url: url)
          request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
          let (bytes, response) = try await session.bytes(for: request)
          try validate(response)

          var buffer = ""
          for try await line in bytes.lines {
            if line.isEmpty {
              if let event = try decodeEventBlock(buffer) {
                continuation.yield(event)
              }
              buffer = ""
            } else {
              buffer += line
              buffer += "\n"
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }

      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }

  private func get<T: Decodable>(_ path: String) async throws -> T {
    var request = URLRequest(url: try endpoint(path))
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
    var request = URLRequest(url: try endpoint(path))
    request.httpMethod = "POST"
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func endpoint(_ path: String, query: [URLQueryItem] = []) throws -> URL {
    guard let baseURL = config.normalizedBaseURL else {
      throw RemoteClientError.invalidBaseURL
    }
    let normalizedPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var components = URLComponents(url: baseURL.appendingPathComponent(normalizedPath), resolvingAgainstBaseURL: false)
    if !query.isEmpty {
      components?.queryItems = query
    }
    guard let url = components?.url else {
      throw RemoteClientError.invalidBaseURL
    }
    return url
  }

  private func validate(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard (200..<300).contains(http.statusCode) else {
      throw RemoteClientError.badStatus(http.statusCode)
    }
  }

  private func decodeEventBlock(_ block: String) throws -> RemoteEvent? {
    let dataLines = block
      .split(separator: "\n", omittingEmptySubsequences: false)
      .filter { $0.hasPrefix("data: ") }
      .map { $0.dropFirst(6) }

    guard !dataLines.isEmpty else { return nil }
    let json = dataLines.joined()
    guard let data = json.data(using: .utf8) else {
      throw RemoteClientError.malformedEvent
    }
    return try JSONDecoder().decode(RemoteEvent.self, from: data)
  }
}
