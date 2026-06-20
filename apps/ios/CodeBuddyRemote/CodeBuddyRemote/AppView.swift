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
      case tool
      case command
      case test
      case plan
      case diff
      case permission
      case artifact
    }

    let id: UUID
    let role: Role
    var title: String
    var text: String
    var status: String
    var toolName: String
    var command: String
    var target: String
    var additions: Int
    var deletions: Int

    init(
      id: UUID = UUID(),
      role: Role,
      title: String = "",
      text: String = "",
      status: String = "",
      toolName: String = "",
      command: String = "",
      target: String = "",
      additions: Int = 0,
      deletions: Int = 0
    ) {
      self.id = id
      self.role = role
      self.title = title
      self.text = text
      self.status = status
      self.toolName = toolName
      self.command = command
      self.target = target
      self.additions = additions
      self.deletions = deletions
    }
  }

  @AppStorage("remote.mode") private var modeRaw = ConnectionMode.relay.rawValue
  @AppStorage("remote.baseURL") private var baseURL = RemoteConfig.defaultValue.baseURL
  @AppStorage("remote.token") private var token = RemoteConfig.defaultValue.token
  @AppStorage("remote.relayURL") private var relayURL = RelayConfig.defaultValue.relayURL
  @AppStorage("remote.pairingCode") private var pairingCode = RelayConfig.defaultValue.pairingCode
  @AppStorage("remote.relayToken") private var relayToken = RelayConfig.defaultValue.token
  @AppStorage("remote.chatLog.v4") private var persistedChatLog = ""

  @State private var sessions: [RemoteSession] = []
  @State private var selectedSessionId = "terminal-cli"
  @State private var terminal = TerminalScreen()
  @State private var chatEntries: [ChatEntry] = []
  @State private var expandedActivityEntryIds = Set<UUID>()
  @State private var chatUpdateToken = 0
  @State private var shouldAutoScroll = true
  @State private var latestHandledSeq = 0
  @State private var statusText = "未连接"
  @State private var prompt = ""
  @State private var isStreaming = false
  @State private var isSettingsPresented = false
  @State private var hasLoadedPersistedChat = false
  @State private var errorMessage: String?
  @State private var streamTask: Task<Void, Never>?
  @State private var persistTask: Task<Void, Never>?
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

  private var maxChatEntries: Int { 240 }

  private var workspaceText: String {
    sessions.first?.workspace ?? "codebuddy-remote"
  }

  var body: some View {
    ZStack {
      Color(.systemBackground)
        .ignoresSafeArea()

      ScrollViewReader { proxy in
        ScrollView(.vertical) {
          LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(chatEntries) { entry in
              messageRow(entry)
            }

            emptyConversation
              .id("conversation-bottom")
          }
          .padding(.horizontal, 20)
          .padding(.top, 18)
          .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.visible)
        .simultaneousGesture(
          DragGesture(minimumDistance: 8)
            .onChanged { _ in
              shouldAutoScroll = false
            }
        )
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

        ZStack(alignment: .topLeading) {
          if prompt.isEmpty {
            Text("向 CodeBuddy 提问")
              .font(.body)
              .foregroundStyle(.secondary)
              .padding(.top, 8)
              .padding(.leading, 5)
          }

          TextEditor(text: $prompt)
            .font(.body)
            .frame(minHeight: 36, maxHeight: 112)
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            .textInputAutocapitalization(.sentences)
            .autocorrectionDisabled()
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
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .system:
      Text(entry.text)
        .font(.body)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .tool, .command, .test, .plan, .diff, .permission, .artifact:
      activityCard(entry)
    }
  }

  private func activityCard(_ entry: ChatEntry) -> some View {
    let isExpanded = isActivityExpanded(entry)
    let canExpand = isExpandableActivity(entry)

    return VStack(alignment: .leading, spacing: 10) {
      Button {
        guard canExpand else { return }
        toggleActivityExpansion(entry)
      } label: {
        activityCardHeader(entry, isExpanded: isExpanded, canExpand: canExpand)
      }
      .buttonStyle(.plain)
      .disabled(!canExpand)

      if isExpanded {
        activityCardDetails(entry)

        if entry.role == .permission, entry.status == "waiting" {
          HStack(spacing: 8) {
            Button("允许一次") {
              sendControlInput("1", label: "允许一次")
            }
            Button("本次允许") {
              sendControlInput("2", label: "本次允许")
            }
            Button("拒绝") {
              sendControlInput("3", label: "拒绝")
            }
          }
          .font(.caption.weight(.semibold))
          .buttonStyle(.bordered)
          .disabled(!isStreaming || selectedSessionId.isEmpty)
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, isExpanded ? 12 : 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(.secondarySystemBackground))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(Color(.separator).opacity(0.35), lineWidth: 1)
    }
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  private func activityCardHeader(
    _ entry: ChatEntry,
    isExpanded: Bool,
    canExpand: Bool
  ) -> some View {
    HStack(alignment: .center, spacing: 9) {
      Image(systemName: iconName(for: entry.role, status: entry.status))
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint(for: entry.role, status: entry.status))
        .frame(width: 20)

      if isExpanded {
        VStack(alignment: .leading, spacing: 2) {
          Text(cardTitle(entry))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(2)
          if !entry.status.isEmpty {
            Text(statusLabel(entry.status))
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      } else {
        Text(cardTitle(entry))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.primary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      if entry.role == .diff {
        HStack(spacing: 6) {
          if entry.additions > 0 {
            Text("+\(entry.additions)")
              .foregroundStyle(.green)
          }
          if entry.deletions > 0 {
            Text("-\(entry.deletions)")
              .foregroundStyle(.red)
          }
        }
        .font(.caption.weight(.semibold))
      }

      if canExpand {
        if !isExpanded, !entry.status.isEmpty {
          Text(statusLabel(entry.status))
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
    }
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private func activityCardDetails(_ entry: ChatEntry) -> some View {
    if !entry.command.isEmpty {
      Text(entry.command)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
        .lineLimit(4)
    } else if !entry.target.isEmpty, entry.target != entry.title {
      Text(entry.target)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(.secondary)
        .lineLimit(3)
    }

    if !entry.text.isEmpty, entry.text != entry.title, entry.text != entry.command {
      Text(entry.text)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(entry.status == "running" || entry.status == "waiting" ? nil : 8)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func cardTitle(_ entry: ChatEntry) -> String {
    if !entry.title.isEmpty {
      return entry.title
    }
    if !entry.target.isEmpty {
      return entry.target
    }
    if !entry.command.isEmpty {
      return entry.command
    }
    return entry.role.rawValue
  }

  private func iconName(for role: ChatEntry.Role, status: String) -> String {
    if status == "failed" {
      return "xmark.circle.fill"
    }
    if status == "passed" {
      return "checkmark.circle.fill"
    }

    switch role {
    case .tool:
      return "magnifyingglass"
    case .command:
      return "terminal"
    case .test:
      return "checklist"
    case .plan:
      return "list.bullet.rectangle"
    case .diff:
      return "doc.text.magnifyingglass"
    case .permission:
      return "hand.raised"
    case .artifact:
      return "paperclip"
    case .user, .assistant, .system:
      return "circle"
    }
  }

  private func tint(for role: ChatEntry.Role, status: String) -> Color {
    if status == "failed" {
      return .red
    }
    if status == "passed" {
      return .green
    }
    if role == .permission {
      return .orange
    }
    if role == .diff {
      return .purple
    }
    if role == .plan {
      return .blue
    }
    return .secondary
  }

  private func statusLabel(_ status: String) -> String {
    switch status {
    case "running":
      return "运行中"
    case "completed":
      return "已完成"
    case "passed":
      return "通过"
    case "failed":
      return "失败"
    case "changed":
      return "有变更"
    case "waiting":
      return "等待确认"
    default:
      return status
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
    chatEntries.removeAll()
    expandedActivityEntryIds.removeAll()
    shouldAutoScroll = true
    persistTask?.cancel()
    persistTask = nil
    persistedChatLog = ""
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

  private func isExpandableActivity(_ entry: ChatEntry) -> Bool {
    switch entry.role {
    case .tool, .command, .test, .plan, .diff, .artifact:
      return true
    case .permission:
      return entry.status != "waiting"
    case .user, .assistant, .system:
      return false
    }
  }

  private func isActivityExpanded(_ entry: ChatEntry) -> Bool {
    if entry.status == "running" || entry.status == "waiting" {
      return true
    }
    return expandedActivityEntryIds.contains(entry.id)
  }

  private func toggleActivityExpansion(_ entry: ChatEntry) {
    if expandedActivityEntryIds.contains(entry.id) {
      expandedActivityEntryIds.remove(entry.id)
    } else {
      expandedActivityEntryIds.insert(entry.id)
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
    trimChatEntriesIfNeeded()
    chatUpdateToken += 1
    schedulePersistChatEntries()
  }

  private func trimChatEntriesIfNeeded() {
    guard chatEntries.count > maxChatEntries else { return }
    let removeCount = chatEntries.count - maxChatEntries
    let removedIds = Set(chatEntries.prefix(removeCount).map(\.id))
    chatEntries.removeFirst(removeCount)
    expandedActivityEntryIds.subtract(removedIds)
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
}

#Preview {
  AppView()
}
