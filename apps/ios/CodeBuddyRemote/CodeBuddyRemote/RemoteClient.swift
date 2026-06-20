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
  var deviceCredential: DeviceCredential? = nil
  var session: URLSession = .shared

  func listSessions() async throws -> [RemoteSession] {
    let response: SessionListResponse = try await get("/api/sessions")
    return response.sessions
  }

  func listEvents(after: Int = 0, before: Int = 0, limit: Int = 0) async throws -> EventListResponse {
    var query = [URLQueryItem(name: "after", value: String(after))]
    if deviceCredential == nil {
      query.insert(URLQueryItem(name: "token", value: config.token), at: 0)
    }
    if before > 0 {
      query.append(URLQueryItem(name: "before", value: String(before)))
    }
    if limit > 0 {
      query.append(URLQueryItem(name: "limit", value: String(limit)))
    }
    return try await get("/api/events", query: query)
  }

  func sendPrompt(sessionId: String, text: String) async throws {
    let _: CommandEnvelope = try await post(
      "/api/sessions/\(sessionId)/messages",
      body: ["text": text]
    )
  }

  func sendTerminalInput(sessionId: String, text: String, label: String) async throws {
    let _: CommandEnvelope = try await post(
      "/api/sessions/\(sessionId)/input",
      body: ["text": text, "label": label]
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

  func bindDevice(_ credential: DeviceCredential) async throws {
    let _: DeviceBindResponse = try await post(
      "/api/devices/bind",
      body: [
        "deviceId": credential.deviceId,
        "deviceSecret": credential.deviceSecret,
        "deviceName": credential.deviceName,
      ],
      forceTokenAuth: true
    )
  }

  func streamEvents(after: Int = 0) -> AsyncThrowingStream<RemoteEvent, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var query = [URLQueryItem(name: "after", value: String(after))]
          if deviceCredential == nil {
            query.insert(URLQueryItem(name: "token", value: config.token), at: 0)
          }
          let url = try endpoint("/api/events/stream", query: query)
          var request = URLRequest(url: url)
          sign(&request, method: "GET", path: "/api/events/stream", body: "")
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

  private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
    var request = URLRequest(url: try endpoint(path, query: query))
    sign(&request, method: "GET", path: path, body: "")
    let (data, response) = try await session.data(for: request)
    try validate(response)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func post<T: Decodable>(
    _ path: String,
    body: [String: String],
    forceTokenAuth: Bool = false
  ) async throws -> T {
    var request = URLRequest(url: try endpoint(path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let bodyData = try JSONEncoder().encode(body)
    request.httpBody = bodyData
    let bodyText = String(data: bodyData, encoding: .utf8) ?? ""
    sign(&request, method: "POST", path: path, body: bodyText, forceTokenAuth: forceTokenAuth)
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

  private func sign(
    _ request: inout URLRequest,
    method: String,
    path: String,
    body: String,
    forceTokenAuth: Bool = false
  ) {
    guard !forceTokenAuth, let deviceCredential else {
      request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
      return
    }

    let timestamp = String(Int(Date().timeIntervalSince1970 * 1000))
    let nonce = UUID().uuidString
    request.setValue(deviceCredential.deviceId, forHTTPHeaderField: "X-CodeBuddy-Device-Id")
    request.setValue(timestamp, forHTTPHeaderField: "X-CodeBuddy-Timestamp")
    request.setValue(nonce, forHTTPHeaderField: "X-CodeBuddy-Nonce")
    request.setValue(
      deviceCredential.signature(
        method: method,
        path: path,
        body: body,
        timestamp: timestamp,
        nonce: nonce
      ),
      forHTTPHeaderField: "X-CodeBuddy-Signature"
    )
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
