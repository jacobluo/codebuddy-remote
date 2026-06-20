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

  private struct ChatEntry: Identifiable, Codable, Equatable {
    enum Role: String, Codable {
      case user
      case assistant
      case system
    }

    let id: UUID
    let role: Role
    var text: String

    init(id: UUID = UUID(), role: Role, text: String) {
      self.id = id
      self.role = role
      self.text = text
    }
  }

  @AppStorage("remote.mode") private var modeRaw = ConnectionMode.relay.rawValue
  @AppStorage("remote.baseURL") private var baseURL = RemoteConfig.defaultValue.baseURL
  @AppStorage("remote.token") private var token = RemoteConfig.defaultValue.token
  @AppStorage("remote.relayURL") private var relayURL = RelayConfig.defaultValue.relayURL
  @AppStorage("remote.pairingCode") private var pairingCode = RelayConfig.defaultValue.pairingCode
  @AppStorage("remote.relayToken") private var relayToken = RelayConfig.defaultValue.token
  @AppStorage("remote.chatLog.v1") private var persistedChatLog = ""

  @State private var sessions: [RemoteSession] = []
  @State private var selectedSessionId = "terminal-cli"
  @State private var terminal = TerminalScreen()
  @State private var terminalAssistantMessages: [String] = []
  @State private var terminalAssistantEntryIds: [UUID] = []
  @State private var chatEntries: [ChatEntry] = []
  @State private var latestHandledSeq = 0
  @State private var statusText = "未连接"
  @State private var prompt = ""
  @State private var isStreaming = false
  @State private var isSettingsPresented = false
  @State private var hasLoadedPersistedChat = false
  @State private var errorMessage: String?
  @State private var streamTask: Task<Void, Never>?
  @State private var relayClient: RelayRemoteClient?

  private var connectionMode: ConnectionMode {
    ConnectionMode(rawValue: modeRaw) ?? .relay
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

  private var workspaceText: String {
    sessions.first?.workspace ?? "codebuddy-remote"
  }

  var body: some View {
    ZStack {
      Color(.systemBackground)
        .ignoresSafeArea()

      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 24) {
            Spacer(minLength: 104)

            ForEach(chatEntries) { entry in
              messageRow(entry)
            }

            emptyConversation
              .id("conversation-bottom")

            Spacer(minLength: 116)
          }
          .padding(.horizontal, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: chatEntries.count) {
          withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
          }
        }
      }
    }
    .onAppear {
      loadPersistedChatIfNeeded()
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      topBar
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      bottomArea
    }
    .sheet(isPresented: $isSettingsPresented) {
      settingsSheet
    }
  }

  private var topBar: some View {
    HStack(spacing: 12) {
      Button {
        isSettingsPresented = true
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 24, weight: .semibold))
          .frame(width: 58, height: 58)
          .foregroundStyle(.primary)
          .background(.ultraThinMaterial)
          .clipShape(Circle())
      }
      .accessibilityLabel("设置")
      .buttonStyle(.plain)

      VStack(alignment: .leading, spacing: 2) {
        Text("CodeBuddy")
          .font(.headline.weight(.semibold))
          .lineLimit(1)
        Text("\(connectionMode.title) · \(workspaceText)")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      HStack(spacing: 18) {
        Button {
          if isStreaming {
            disconnect()
          } else {
            connect()
          }
        } label: {
          Image(systemName: isStreaming ? "stop.circle" : "square.and.pencil")
            .font(.system(size: 25, weight: .semibold))
        }
        .accessibilityLabel(isStreaming ? "断开" : "连接")
        .buttonStyle(.plain)

        Menu {
          Button("连接") {
            connect()
          }
          .disabled(isStreaming)

          Button("断开") {
            disconnect()
          }
          .disabled(!isStreaming)

          Button("中断") {
            runAction(.interrupt)
          }
          .disabled(!isStreaming)

          Button("恢复") {
            runAction(.resume)
          }
          .disabled(!isStreaming)

          Button("连接设置") {
            isSettingsPresented = true
          }
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 25, weight: .bold))
        }
        .accessibilityLabel("更多")
        .buttonStyle(.plain)
      }
      .foregroundStyle(.primary)
      .padding(.horizontal, 20)
      .frame(height: 58)
      .background(.ultraThinMaterial)
      .clipShape(Capsule())
    }
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 12)
    .background {
      Rectangle()
        .fill(.ultraThinMaterial)
        .mask(
          LinearGradient(
            colors: [.black, .black.opacity(0)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .ignoresSafeArea()
    }
  }

  private var bottomArea: some View {
    VStack(spacing: 10) {
      if let errorMessage {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(.red)
          .lineLimit(2)
          .multilineTextAlignment(.center)
      } else {
        Text(statusLine)
          .font(.footnote.weight(.medium))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      HStack(spacing: 14) {
        Button {
          isSettingsPresented = true
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 27, weight: .regular))
            .frame(width: 34, height: 34)
            .foregroundStyle(.primary)
        }
        .accessibilityLabel("连接设置")
        .buttonStyle(.plain)

        TextField("向 CodeBuddy 提问", text: $prompt, axis: .vertical)
          .font(.body)
          .lineLimit(1...5)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.send)
          .onSubmit {
            sendPrompt()
          }

        Button {
          if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            isSettingsPresented = true
          } else {
            sendPrompt()
          }
        } label: {
          Image(systemName: prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "mic" : "arrow.up.circle.fill")
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(.primary)
        }
        .accessibilityLabel(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "语音输入" : "发送")
        .disabled(!isStreaming || selectedSessionId.isEmpty)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(.ultraThinMaterial)
      .clipShape(Capsule())
      .shadow(color: .black.opacity(0.10), radius: 24, x: 0, y: 8)
    }
    .padding(.horizontal, 22)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .background {
      Rectangle()
        .fill(.ultraThinMaterial)
        .mask(
          LinearGradient(
            colors: [.black.opacity(0), .black, .black],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .ignoresSafeArea()
    }
  }

  private var statusLine: String {
    if isStreaming {
      return "\(ProcessInfo.processInfo.hostName) \(statusText)"
    }
    return "未连接"
  }

  @ViewBuilder
  private var emptyConversation: some View {
    if isStreaming || !chatEntries.isEmpty {
      Color.clear
        .frame(maxWidth: .infinity, minHeight: 1)
        .padding(.top, 48)
    } else {
      VStack(alignment: .leading, spacing: 14) {
        Text("未连接")
          .font(.title2.weight(.semibold))
        Button {
          connect()
        } label: {
          Label("连接", systemImage: "link")
        }
        .buttonStyle(.borderedProminent)
        .disabled(isStreaming)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 48)
    }
  }

  @ViewBuilder
  private func messageRow(_ entry: ChatEntry) -> some View {
    switch entry.role {
    case .user:
      HStack {
        Spacer(minLength: 48)
        Text(entry.text)
          .font(.body)
          .foregroundStyle(.primary)
          .padding(.horizontal, 18)
          .padding(.vertical, 12)
          .background(Color(.secondarySystemFill))
          .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
    case .assistant:
      Text(entry.text)
        .font(.body)
        .foregroundStyle(.primary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .system:
      Text(entry.text)
        .font(.body)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var settingsSheet: some View {
    NavigationStack {
      Form {
        Section("连接") {
          Picker("模式", selection: $modeRaw) {
            ForEach(ConnectionMode.allCases) { mode in
              Text(mode.title).tag(mode.rawValue)
            }
          }
          .pickerStyle(.segmented)
          .disabled(isStreaming)

          if connectionMode == .local {
            TextField("Mac 地址", text: $baseURL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)

            SecureField("Token", text: $token)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
          } else {
            TextField("Relay 地址", text: $relayURL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)

            TextField("配对码", text: $pairingCode)
              .textInputAutocapitalization(.characters)
              .autocorrectionDisabled()

            SecureField("Relay Token，可选", text: $relayToken)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
          }
        }

        Section("Session") {
          LabeledContent("状态", value: statusText)
          LabeledContent("Workspace", value: workspaceText)
        }
      }
      .navigationTitle("连接设置")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("关闭") {
            isSettingsPresented = false
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(isStreaming ? "断开" : "连接") {
            if isStreaming {
              disconnect()
            } else {
              connect()
            }
            isSettingsPresented = false
          }
        }
      }
    }
  }

  private func connect() {
    disconnect()
    errorMessage = nil
    terminal = TerminalScreen()
    terminalAssistantMessages.removeAll()
    terminalAssistantEntryIds.removeAll()
    chatEntries.removeAll()
    latestHandledSeq = 0
    statusText = "正在连接"

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
          let eventStream = relay.streamEvents()
          try await relay.connect()
          sessions = try await relay.listSessions()
          selectedSessionId = sessions.first?.id ?? "terminal-cli"
          let replay = try await relay.listEvents(after: 0)
          for event in replay.events {
            handle(event)
          }
          statusText = selectedSessionId.isEmpty ? "没有可用 session" : "Relay 已连接 \(selectedSessionId)"
          isStreaming = true

          for try await event in eventStream {
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
    if statusText != "正在连接" {
      statusText = "未连接"
    }
  }

  private func sendPrompt() {
    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    prompt = ""
    errorMessage = nil
    appendUserMessage(text)

    Task {
      do {
        if connectionMode == .local {
          try await client.sendPrompt(sessionId: selectedSessionId, text: text)
        } else {
          try await relayClient?.sendPrompt(sessionId: selectedSessionId, text: text)
        }
        errorMessage = nil
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func runAction(_ action: SessionAction) {
    errorMessage = nil
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
        errorMessage = nil
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func handle(_ event: RemoteEvent) {
    if event.seq <= latestHandledSeq {
      return
    }
    latestHandledSeq = event.seq

    switch event.name {
    case "user.message":
      if let text = event.payload.text {
        appendUserMessage(text)
      }
    case "assistant.delta", "assistant.completed":
      if let text = event.payload.text, !text.isEmpty {
        appendAssistantMessage(text)
      }
    case "terminal.output":
      if let text = event.payload.text {
        terminal.write(text)
        syncAssistantMessagesFromTerminal()
      }
    case "session.state":
      if let status = event.payload.status {
        statusText = "状态：\(status)"
      }
    case "error":
      if let text = event.payload.text {
        errorMessage = text
      }
    default:
      break
    }
  }

  private func appendUserMessage(_ text: String) {
    if chatEntries.last?.role == .user, chatEntries.last?.text == text {
      return
    }
    chatEntries.append(ChatEntry(role: .user, text: text))
    persistChatEntries()
  }

  private func appendAssistantMessage(_ text: String) {
    if chatEntries.last?.role == .assistant, chatEntries.last?.text == text {
      return
    }
    chatEntries.append(ChatEntry(role: .assistant, text: text))
    persistChatEntries()
  }

  private func syncAssistantMessagesFromTerminal() {
    let messages = terminal.assistantMessages
    guard messages != terminalAssistantMessages else { return }

    for index in messages.indices {
      if index < terminalAssistantEntryIds.count {
        let entryId = terminalAssistantEntryIds[index]
        if let entryIndex = chatEntries.firstIndex(where: { $0.id == entryId }) {
          chatEntries[entryIndex].text = messages[index]
        }
      } else {
        let entry = ChatEntry(role: .assistant, text: messages[index])
        terminalAssistantEntryIds.append(entry.id)
        chatEntries.append(entry)
      }
    }

    if messages.count < terminalAssistantEntryIds.count {
      let staleIds = Set(terminalAssistantEntryIds.dropFirst(messages.count))
      chatEntries.removeAll { staleIds.contains($0.id) }
      terminalAssistantEntryIds = Array(terminalAssistantEntryIds.prefix(messages.count))
    }

    terminalAssistantMessages = messages
    persistChatEntries()
  }

  private func loadPersistedChatIfNeeded() {
    guard !hasLoadedPersistedChat else { return }
    hasLoadedPersistedChat = true
    guard let data = persistedChatLog.data(using: .utf8), !data.isEmpty else {
      return
    }
    if let decoded = try? JSONDecoder().decode([ChatEntry].self, from: data) {
      chatEntries = decoded
    }
  }

  private func persistChatEntries() {
    guard let data = try? JSONEncoder().encode(chatEntries),
          let text = String(data: data, encoding: .utf8)
    else {
      return
    }
    persistedChatLog = text
  }
}

#Preview {
  AppView()
}
