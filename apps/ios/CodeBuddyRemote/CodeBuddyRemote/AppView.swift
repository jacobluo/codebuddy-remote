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

  @Environment(AppState.self) private var appState

  @AppStorage("remote.mode") private var modeRaw = ConnectionMode.relay.rawValue
  @AppStorage("remote.baseURL") private var baseURL = RemoteConfig.defaultValue.baseURL
  @AppStorage("remote.token") private var token = RemoteConfig.defaultValue.token
  @AppStorage("remote.relayURL") private var relayURL = RelayConfig.defaultValue.relayURL
  @AppStorage("remote.pairingCode") private var pairingCode = RelayConfig.defaultValue.pairingCode
  @AppStorage("remote.relayPairingSecret") private var relayPairingSecret = RelayConfig.defaultValue.pairingSecret
  @AppStorage("remote.relayToken") private var relayToken = RelayConfig.defaultValue.token
  @AppStorage("remote.pairedWorkspace") private var pairedWorkspace = ""
  @AppStorage("remote.pairedHost") private var pairedHost = ""
  @AppStorage("remote.chatLog.v4") private var persistedChatLog = ""

  @State private var sessions: [RemoteSession] = []
  @State private var selectedSessionId = "terminal-cli"
  @State private var terminal = TerminalScreen()
  @State private var chatEntries: [ChatEntry] = []
  @State private var expandedActivityEntryIds = Set<UUID>()
  @State private var expandedActivityGroupIds = Set<UUID>()
  @State private var chatUpdateToken = 0
  @State private var shouldAutoScroll = true
  @State private var latestHandledSeq = 0
  @State private var statusText = "未连接"
  @State private var prompt = ""
  @State private var pairingURLText = ""
  @State private var isStreaming = false
  @State private var isSettingsPresented = false
  @State private var isPairingScannerPresented = false
  @State private var isAttachmentMenuPresented = false
  @State private var hasLoadedPersistedChat = false
  @State private var errorMessage: String?
  @State private var localDeviceCredential: DeviceCredential?
  @State private var streamTask: Task<Void, Never>?
  @State private var persistTask: Task<Void, Never>?
  @State private var chatNotifyTask: Task<Void, Never>?
  @State private var relayClient: RelayRemoteClient?

  private var connectionMode: ConnectionMode {
    ConnectionMode(rawValue: modeRaw) ?? .relay
  }

  private var config: RemoteConfig {
    RemoteConfig(baseURL: baseURL, token: token)
  }

  private var relayConfig: RelayConfig {
    RelayConfig(relayURL: relayURL, pairingCode: pairingCode, pairingSecret: relayPairingSecret, token: relayToken)
  }

  private var client: RemoteClient {
    RemoteClient(config: config, deviceCredential: localDeviceCredential)
  }

  private var maxRenderedChatEntries: Int { 80 }
  private var initialReplayEventLimit: Int { 120 }

  private var workspaceText: String {
    if !pairedWorkspace.isEmpty {
      return pairedWorkspace
    }
    return sessions.first?.workspace ?? "codebuddy-remote"
  }

  private var hostText: String {
    if !pairedHost.isEmpty {
      return pairedHost
    }
    return ProcessInfo.processInfo.hostName
  }

  private var bindingStateText: String {
    switch connectionMode {
    case .local:
      if let credential = localDeviceCredential {
        return "已绑定 \(credential.deviceName)"
      }
      return "未绑定"
    case .relay:
      return relayPairingSecret.isEmpty ? "未配置配对密钥" : "已配置配对密钥"
    }
  }

  private var conversationItems: [ConversationItem] {
    ChatDisplayBuilder.conversationItems(from: visibleChatEntries)
  }

  private var visibleChatEntries: [ChatEntry] {
    guard chatEntries.count > maxRenderedChatEntries else { return chatEntries }
    return Array(chatEntries.suffix(maxRenderedChatEntries))
  }

  var body: some View {
    ZStack {
      Color(.systemBackground)
        .ignoresSafeArea()

      ScrollViewReader { proxy in
        ScrollView(.vertical) {
          LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(conversationItems) { item in
              ConversationRowView(
                item: item,
                expandedActivityEntryIds: expandedActivityEntryIds,
                expandedActivityGroupIds: expandedActivityGroupIds,
                isStreaming: isStreaming,
                selectedSessionId: selectedSessionId,
                onToggleActivity: toggleActivityExpansion,
                onToggleGroup: toggleActivityGroupExpansion,
                onPermissionInput: { text, label in
                  sendControlInput(text, label: label)
                }
              )
            }

            emptyConversation
              .id("conversation-bottom")
          }
          .padding(.horizontal, 20)
          .padding(.top, 10)
          .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.visible)
        .onChange(of: chatUpdateToken) {
          guard shouldAutoScroll else { return }
          withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
          }
        }
      }
    }
    .onAppear {
      loadPersistedChatIfNeeded()
      localDeviceCredential = DeviceCredentialStore.load()
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
    .sheet(isPresented: $isPairingScannerPresented) {
      pairingScannerSheet
    }
    .onChange(of: appState.pendingPairingCode) {
      guard let code = appState.pendingPairingCode else { return }
      handlePairingCode(code)
      appState.pendingPairingCode = nil
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
        Text("\(connectionMode.title) · \(workspaceText) · \(hostText)")
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
          Button("扫码绑定") {
            isPairingScannerPresented = true
          }

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
        .fill(.regularMaterial)
        .ignoresSafeArea(edges: .top)
    }
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Color(.separator).opacity(0.25))
        .frame(height: 0.5)
    }
  }

  private var bottomArea: some View {
    ChatInputDock(
      prompt: $prompt,
      isAttachmentMenuPresented: $isAttachmentMenuPresented,
      statusLine: statusLine,
      errorMessage: errorMessage,
      isEnabled: isStreaming && !selectedSessionId.isEmpty,
      onSend: sendPrompt,
      onAttachment: handleAttachmentAction
    )
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

            SecureField("配对密钥", text: $relayPairingSecret)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
          }
        }

        Section("配对") {
          Button {
            isPairingScannerPresented = true
          } label: {
            Label("扫码绑定", systemImage: "qrcode.viewfinder")
          }

          TextField("粘贴 Pairing URL", text: $pairingURLText)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)

          Button {
            handlePairingCode(pairingURLText)
          } label: {
            Label("使用 Pairing URL", systemImage: "link.badge.plus")
          }
          .disabled(pairingURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        Section("Session") {
          LabeledContent("状态", value: statusText)
          LabeledContent("Workspace", value: workspaceText)
        }

        Section("当前连接") {
          LabeledContent("模式", value: connectionMode.title)
          LabeledContent("Host", value: hostText)
          LabeledContent("Workspace", value: workspaceText)
          LabeledContent("绑定", value: bindingStateText)
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

  private var pairingScannerSheet: some View {
    NavigationStack {
      QRCodeScannerView(
        onScan: handlePairingCode,
        onError: { message in
          errorMessage = message
          isPairingScannerPresented = false
        }
      )
      .ignoresSafeArea(edges: .bottom)
      .navigationTitle("扫码绑定")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("关闭") {
            isPairingScannerPresented = false
          }
        }
      }
    }
  }

  private func connect() {
    disconnect()
    errorMessage = nil
    terminal = TerminalScreen()
    chatEntries.removeAll()
    expandedActivityEntryIds.removeAll()
    expandedActivityGroupIds.removeAll()
    shouldAutoScroll = true
    persistTask?.cancel()
    persistTask = nil
    chatNotifyTask?.cancel()
    chatNotifyTask = nil
    persistedChatLog = ""
    latestHandledSeq = 0
    statusText = "正在连接"

    streamTask = Task {
      do {
        if connectionMode == .local {
          sessions = try await client.listSessions()
          selectedSessionId = sessions.first?.id ?? "terminal-cli"
          let replay = try await client.listEvents(after: 0, limit: initialReplayEventLimit)
          for event in replay.events {
            handle(event)
          }
          statusText = selectedSessionId.isEmpty ? "没有可用 session" : "已连接 \(selectedSessionId)"
          isStreaming = true

          for try await event in client.streamEvents(after: replay.latestSeq) {
            handle(event)
          }
        } else {
          let credential = localDeviceCredential ?? DeviceCredential.generate()
          if localDeviceCredential == nil {
            try? DeviceCredentialStore.save(credential)
            localDeviceCredential = credential
          }
          let relay = RelayRemoteClient(config: relayConfig, deviceCredential: credential)
          relayClient = relay
          let eventStream = relay.streamEvents()
          try await relay.connect()
          sessions = try await relay.listSessions()
          selectedSessionId = sessions.first?.id ?? "terminal-cli"
          let replay = try await relay.listEvents(after: 0, limit: initialReplayEventLimit)
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

  private func handlePairingCode(_ code: String) {
    do {
      let payload = try PairingPayload.parse(code.trimmingCharacters(in: .whitespacesAndNewlines))
      applyPairingPayload(payload)
      pairingURLText = ""
      isPairingScannerPresented = false
      isSettingsPresented = false
      if payload.mode == .local {
        Task {
          await bindLocalDeviceAndConnect()
        }
      } else {
        connect()
      }
    } catch {
      errorMessage = error.localizedDescription
      isPairingScannerPresented = false
    }
  }

  private func applyPairingPayload(_ payload: PairingPayload) {
    pairedWorkspace = payload.workspace
    pairedHost = payload.host
    switch payload.mode {
    case .local:
      modeRaw = ConnectionMode.local.rawValue
      baseURL = payload.baseURL
      token = payload.token
    case .relay:
      modeRaw = ConnectionMode.relay.rawValue
      relayURL = payload.relayURL
      relayToken = payload.relayToken
      pairingCode = payload.pairingCode
      relayPairingSecret = payload.pairingSecret
    }
  }

  private func bindLocalDeviceAndConnect() async {
    do {
      let credential = localDeviceCredential ?? DeviceCredential.generate()
      try await RemoteClient(config: config).bindDevice(credential)
      try DeviceCredentialStore.save(credential)
      localDeviceCredential = credential
      connect()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func sendPrompt() {
    let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    prompt = ""
    isAttachmentMenuPresented = false
    shouldAutoScroll = true
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

  private func handleAttachmentAction(_ action: AttachmentAction) {
    isAttachmentMenuPresented = false
    errorMessage = "\(action.title)暂未接入"
  }

  private func sendControlInput(_ text: String, label: String) {
    errorMessage = nil
    Task {
      do {
        if connectionMode == .local {
          try await client.sendTerminalInput(sessionId: selectedSessionId, text: text, label: label)
        } else {
          try await relayClient?.sendTerminalInput(sessionId: selectedSessionId, text: text, label: label)
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
    case "tool.requested":
      appendActivityCard(from: event.payload, defaultStatus: "running")
    case "tool.output":
      appendActivityCard(from: event.payload, defaultStatus: "completed")
    case "tool.permissionRequested":
      appendActivityCard(from: event.payload, defaultStatus: "waiting")
    case "tool.permissionResolved":
      resolvePermissionCard(from: event.payload)
    case "diff.created":
      appendActivityCard(from: event.payload, defaultStatus: "changed")
    case "terminal.output":
      if let text = event.payload.text {
        terminal.write(text)
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
    persistChatEntriesAndNotify()
  }

  private func appendAssistantMessage(_ text: String) {
    let text = sanitizedAssistantText(text)
    guard !text.isEmpty else { return }

    if let last = chatEntries.last, last.role == .assistant {
      if last.text == text || last.text.hasSuffix("\n\(text)") {
        return
      }
      chatEntries[chatEntries.count - 1].text += "\n\(text)"
    } else {
      chatEntries.append(ChatEntry(role: .assistant, text: text))
    }
    persistChatEntriesAndNotify()
  }

  private func appendActivityCard(from payload: EventPayload, defaultStatus: String) {
    let entry = ChatEntry(
      role: role(for: payload.kind),
      title: payload.title ?? "",
      text: payload.text ?? "",
      status: payload.status ?? defaultStatus,
      toolName: payload.toolName ?? "",
      command: payload.command ?? "",
      target: payload.target ?? "",
      additions: payload.additions ?? 0,
      deletions: payload.deletions ?? 0
    )

    if let index = matchingActivityIndex(for: entry) {
      chatEntries[index] = entry
    } else {
      chatEntries.append(entry)
    }
    persistChatEntriesAndNotify()
  }

  private func resolvePermissionCard(from payload: EventPayload) {
    if let index = chatEntries.lastIndex(where: { $0.role == .permission && $0.status == "waiting" }) {
      chatEntries[index].title = payload.title ?? chatEntries[index].title
      chatEntries[index].text = payload.text ?? chatEntries[index].text
      chatEntries[index].status = payload.status ?? "completed"
      persistChatEntriesAndNotify()
      return
    }

    appendActivityCard(from: payload, defaultStatus: "completed")
  }

  private func role(for kind: String?) -> ChatEntry.Role {
    switch kind {
    case "command":
      return .command
    case "test":
      return .test
    case "plan":
      return .plan
    case "diff", "edit":
      return .diff
    case "permission":
      return .permission
    case "artifact":
      return .artifact
    default:
      return .tool
    }
  }

  private func isSameActivity(_ lhs: ChatEntry, _ rhs: ChatEntry) -> Bool {
    guard lhs.role == rhs.role else { return false }
    guard lhs.role != .user, lhs.role != .assistant, lhs.role != .system else {
      return lhs.title == rhs.title && lhs.text == rhs.text
    }

    if !lhs.command.isEmpty || !rhs.command.isEmpty {
      return lhs.command == rhs.command
    }

    if !lhs.target.isEmpty || !rhs.target.isEmpty {
      return lhs.target == rhs.target && lhs.toolName == rhs.toolName
    }

    return lhs.title == rhs.title && lhs.toolName == rhs.toolName
  }

  private func matchingActivityIndex(for entry: ChatEntry) -> Int? {
    if let last = chatEntries.last, isSameActivity(last, entry) {
      return chatEntries.indices.last
    }

    guard entry.role != .user, entry.role != .assistant, entry.role != .system else {
      return nil
    }

    return chatEntries.lastIndex { candidate in
      isSameActivity(candidate, entry) &&
        candidate.status == "running" &&
        candidate.role == entry.role
    }
  }

  private func toggleActivityExpansion(_ entry: ChatEntry) {
    if expandedActivityEntryIds.contains(entry.id) {
      expandedActivityEntryIds.remove(entry.id)
    } else {
      expandedActivityEntryIds.insert(entry.id)
    }
  }

  private func toggleActivityGroupExpansion(_ group: ActivityGroup) {
    if expandedActivityGroupIds.contains(group.id) {
      expandedActivityGroupIds.remove(group.id)
    } else {
      expandedActivityGroupIds.insert(group.id)
    }
  }

  private func sanitizedAssistantText(_ text: String) -> String {
    text
      .components(separatedBy: .newlines)
      .compactMap { rawLine in
        var line = rawLine
          .replacingOccurrences(of: #"\u{1B}\][\s\S]*?(\u{7}|\u{1B}\\)"#, with: "", options: .regularExpression)
          .replacingOccurrences(of: #"\u{1B}\[[0-?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
          .replacingOccurrences(of: #"\[[?0-9;]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
          .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
          .trimmingCharacters(in: .whitespacesAndNewlines)

        if line.hasPrefix("● ") {
          line.removeFirst(2)
          line = line.replacingOccurrences(
            of: #"^[A-Za-z][A-Za-z0-9_-]*\s+·\s+"#,
            with: "",
            options: .regularExpression
          )
        }

        if let markerRange = line.range(of: "⎿") {
          line = String(line[..<markerRange.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return shouldKeepAssistantLine(line) ? line : nil
      }
      .joined(separator: "\n")
  }

  private func shouldKeepAssistantLine(_ line: String) -> Bool {
    if line.isEmpty { return false }
    if line == "? for shortcuts" { return false }
    if line.hasPrefix(">") { return false }
    if line.hasPrefix("Tip:") { return false }
    if line.hasPrefix("Bash(") || line.hasPrefix("Read(") || line.hasPrefix("Search(") { return false }
    if line.hasPrefix("Explore ·") { return false }
    if line.contains("Explore ·"), line.range(of: #"\b(streaming|processing|running|writing|waiting for permission)\b"#, options: .regularExpression) != nil {
      return false
    }
    if line.range(of: #"^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+"#, options: .regularExpression) != nil {
      return false
    }
    if line.contains("· Bash(") || line.contains("· Read(") || line.contains("· Search(") { return false }
    if line.contains("· Edit(") || line.contains("· Write(") || line.contains("· Glob(") { return false }
    if line.contains("Waking…") || line.contains("Sweeping…") { return false }
    if line.contains("esc to interrupt") || line.contains("Press Shift+Tab") { return false }
    if line.contains("────") { return false }
    return true
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

  private func persistChatEntriesAndNotify() {
    scheduleChatUpdate()
    schedulePersistChatEntries()
  }

  private func schedulePersistChatEntries() {
    persistTask?.cancel()
    let snapshot = chatEntries
    persistTask = Task {
      try? await Task.sleep(nanoseconds: 300_000_000)
      guard !Task.isCancelled else { return }
      guard let data = try? JSONEncoder().encode(snapshot),
            let text = String(data: data, encoding: .utf8)
      else {
        return
      }
      persistedChatLog = text
    }
  }

  private func scheduleChatUpdate() {
    guard chatNotifyTask == nil else { return }
    chatNotifyTask = Task {
      try? await Task.sleep(nanoseconds: 80_000_000)
      guard !Task.isCancelled else { return }
      chatUpdateToken += 1
      chatNotifyTask = nil
    }
  }
}

#Preview {
  AppView()
}
