import SwiftUI

@MainActor
struct AppView: View {
  private enum ConnectionMode: String, CaseIterable, Identifiable {
    case local
    case relay

    var id: String { rawValue }

    var title: String {
      switch self {
      case .local:
        "局域网"
      case .relay:
        "Relay"
      }
    }
  }

  private enum SessionAction {
    case interrupt
    case resume
  }

  @AppStorage("remote.mode") private var modeRaw = ConnectionMode.local.rawValue
  @AppStorage("remote.baseURL") private var baseURL = RemoteConfig.defaultValue.baseURL
  @AppStorage("remote.token") private var token = RemoteConfig.defaultValue.token
  @AppStorage("remote.relayURL") private var relayURL = RelayConfig.defaultValue.relayURL
  @AppStorage("remote.pairingCode") private var pairingCode = RelayConfig.defaultValue.pairingCode
  @AppStorage("remote.relayToken") private var relayToken = RelayConfig.defaultValue.token

  @State private var sessions: [RemoteSession] = []
  @State private var selectedSessionId = "terminal-cli"
  @State private var terminal = TerminalScreen()
  @State private var statusText = "未连接"
  @State private var prompt = ""
  @State private var isStreaming = false
  @State private var errorMessage: String?
  @State private var streamTask: Task<Void, Never>?
  @State private var relayClient: RelayRemoteClient?

  private var connectionMode: ConnectionMode {
    ConnectionMode(rawValue: modeRaw) ?? .local
  }

  private var config: RemoteConfig {
    RemoteConfig(baseURL: baseURL, token: token)
  }

  private var relayConfig: RelayConfig {
    RelayConfig(relayURL: relayURL, pairingCode: pairingCode, token: relayToken)
  }

  private var client: RemoteClient {
    RemoteClient(config: config)
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 12) {
        connectionPanel
        terminalPanel
        composer
      }
      .padding()
      .background(Color(.systemGroupedBackground))
      .navigationTitle("CodeBuddy Remote")
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button("连接") {
            connect()
          }
          .disabled(isStreaming)

          Button("断开") {
            disconnect()
          }
          .disabled(!isStreaming)
        }
      }
    }
  }

  private var connectionPanel: some View {
    VStack(alignment: .leading, spacing: 10) {
      Picker("连接模式", selection: $modeRaw) {
        ForEach(ConnectionMode.allCases) { mode in
          Text(mode.title).tag(mode.rawValue)
        }
      }
      .pickerStyle(.segmented)
      .disabled(isStreaming)

      if connectionMode == .local {
        TextField("Mac 地址，例如 http://192.168.50.160:17320", text: $baseURL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .textFieldStyle(.roundedBorder)

        SecureField("Token", text: $token)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .textFieldStyle(.roundedBorder)
      } else {
        TextField("Relay 地址，例如 wss://relay.example.com/relay", text: $relayURL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .textFieldStyle(.roundedBorder)

        TextField("配对码", text: $pairingCode)
          .textInputAutocapitalization(.characters)
          .autocorrectionDisabled()
          .textFieldStyle(.roundedBorder)

        SecureField("Relay Token，可选", text: $relayToken)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .textFieldStyle(.roundedBorder)
      }

      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text(statusText)
            .font(.subheadline.weight(.semibold))
          if let workspace = sessions.first?.workspace {
            Text(workspace)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        Spacer()
        statusBadge
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
    .padding()
    .background(.background)
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  private var terminalPanel: some View {
    ScrollViewReader { proxy in
      ScrollView {
        Text(terminal.text.isEmpty ? "等待终端输出..." : terminal.text)
          .font(.system(.footnote, design: .monospaced))
          .foregroundStyle(Color(red: 0.91, green: 0.94, blue: 0.98))
          .frame(maxWidth: .infinity, alignment: .topLeading)
          .padding(12)
          .id("terminal-bottom")
      }
      .background(Color(red: 0.04, green: 0.06, blue: 0.12))
      .clipShape(RoundedRectangle(cornerRadius: 8))
      .onChange(of: terminal.text) {
        proxy.scrollTo("terminal-bottom", anchor: .bottom)
      }
    }
  }

  private var composer: some View {
    VStack(spacing: 10) {
      TextEditor(text: $prompt)
        .frame(minHeight: 82, maxHeight: 120)
        .padding(8)
        .background(.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))

      HStack {
        Button("中断") {
          runAction(.interrupt)
        }
        .buttonStyle(.bordered)

        Button("恢复") {
          runAction(.resume)
        }
        .buttonStyle(.bordered)

        Spacer()

        Button("发送") {
          sendPrompt()
        }
        .buttonStyle(.borderedProminent)
        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedSessionId.isEmpty)
      }
    }
  }

  private var statusBadge: some View {
    Text(isStreaming ? "在线" : "离线")
      .font(.caption.weight(.semibold))
      .foregroundStyle(isStreaming ? .green : .secondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background((isStreaming ? Color.green : Color.gray).opacity(0.12))
      .clipShape(Capsule())
  }

  private func connect() {
    disconnect()
    errorMessage = nil
    statusText = "正在连接..."

    streamTask = Task {
      do {
        if connectionMode == .local {
          sessions = try await client.listSessions()
          selectedSessionId = sessions.first?.id ?? "terminal-cli"
          statusText = selectedSessionId.isEmpty ? "没有可用 session" : "已连接 \(selectedSessionId)"
          isStreaming = true

          for try await event in client.streamEvents() {
            handle(event)
          }
        } else {
          let relay = RelayRemoteClient(config: relayConfig)
          relayClient = relay
          try await relay.connect()
          sessions = try await relay.listSessions()
          selectedSessionId = sessions.first?.id ?? "terminal-cli"
          statusText = selectedSessionId.isEmpty ? "没有可用 session" : "Relay 已连接 \(selectedSessionId)"
          isStreaming = true

          for try await event in relay.streamEvents() {
            handle(event)
          }
        }
      } catch is CancellationError {
        return
      } catch {
        isStreaming = false
        statusText = "连接失败"
        errorMessage = error.localizedDescription
      }
    }
  }

  private func disconnect() {
    streamTask?.cancel()
    streamTask = nil
    relayClient?.disconnect()
    relayClient = nil
    isStreaming = false
    if statusText != "正在连接..." {
      statusText = "未连接"
    }
  }

  private func sendPrompt() {
    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    prompt = ""

    Task {
      do {
        if connectionMode == .local {
          try await client.sendPrompt(sessionId: selectedSessionId, text: text)
        } else {
          try await relayClient?.sendPrompt(sessionId: selectedSessionId, text: text)
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func runAction(_ action: SessionAction) {
    Task {
      do {
        switch action {
        case .interrupt:
          if connectionMode == .local {
            try await client.interrupt(sessionId: selectedSessionId)
          } else {
            try await relayClient?.interrupt(sessionId: selectedSessionId)
          }
        case .resume:
          if connectionMode == .local {
            try await client.resume(sessionId: selectedSessionId)
          } else {
            try await relayClient?.resume(sessionId: selectedSessionId)
          }
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func handle(_ event: RemoteEvent) {
    switch event.name {
    case "terminal.output":
      if let text = event.payload.text {
        terminal.write(text)
      }
    case "session.state":
      if let status = event.payload.status {
        statusText = "状态：\(status)"
      }
    default:
      break
    }
  }
}

#Preview {
  AppView()
}
