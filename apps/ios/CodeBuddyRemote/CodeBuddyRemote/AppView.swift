import SwiftUI

@MainActor
struct AppView: View {
  @AppStorage("remote.baseURL") private var baseURL = RemoteConfig.defaultValue.baseURL
  @AppStorage("remote.token") private var token = RemoteConfig.defaultValue.token

  @State private var sessions: [RemoteSession] = []
  @State private var selectedSessionId = "terminal-cli"
  @State private var terminal = TerminalScreen()
  @State private var statusText = "未连接"
  @State private var prompt = ""
  @State private var isStreaming = false
  @State private var errorMessage: String?
  @State private var streamTask: Task<Void, Never>?

  private var config: RemoteConfig {
    RemoteConfig(baseURL: baseURL, token: token)
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
      TextField("Mac 地址，例如 http://192.168.50.160:17320", text: $baseURL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .textFieldStyle(.roundedBorder)

      SecureField("Token", text: $token)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .textFieldStyle(.roundedBorder)

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
        sessions = try await client.listSessions()
        selectedSessionId = sessions.first?.id ?? "terminal-cli"
        statusText = selectedSessionId.isEmpty ? "没有可用 session" : "已连接 \(selectedSessionId)"
        isStreaming = true

        for try await event in client.streamEvents() {
          handle(event)
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
        try await client.sendPrompt(sessionId: selectedSessionId, text: text)
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private enum SessionAction {
    case interrupt
    case resume
  }

  private func runAction(_ action: SessionAction) {
    Task {
      do {
        switch action {
        case .interrupt:
          try await client.interrupt(sessionId: selectedSessionId)
        case .resume:
          try await client.resume(sessionId: selectedSessionId)
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
