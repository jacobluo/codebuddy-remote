import SwiftUI

struct ConversationRowView: View {
  let item: ConversationItem
  let expandedActivityEntryIds: Set<UUID>
  let expandedActivityGroupIds: Set<UUID>
  let isStreaming: Bool
  let selectedSessionId: String
  let onToggleActivity: (ChatEntry) -> Void
  let onToggleGroup: (ActivityGroup) -> Void
  let onPermissionInput: (String, String) -> Void

  var body: some View {
    switch item {
    case .entry(let entry):
      ChatEntryView(
        entry: entry,
        isExpanded: isActivityExpanded(entry),
        isStreaming: isStreaming,
        selectedSessionId: selectedSessionId,
        onToggleActivity: onToggleActivity,
        onPermissionInput: onPermissionInput
      )
    case .activityGroup(let group):
      ActivityGroupCard(
        group: group,
        isExpanded: expandedActivityGroupIds.contains(group.id),
        expandedActivityEntryIds: expandedActivityEntryIds,
        isStreaming: isStreaming,
        selectedSessionId: selectedSessionId,
        onToggleGroup: onToggleGroup,
        onToggleActivity: onToggleActivity,
        onPermissionInput: onPermissionInput
      )
    }
  }

  private func isActivityExpanded(_ entry: ChatEntry) -> Bool {
    if entry.status == "running" || entry.status == "waiting" {
      return true
    }
    return expandedActivityEntryIds.contains(entry.id)
  }
}

private struct ChatEntryView: View {
  let entry: ChatEntry
  let isExpanded: Bool
  let isStreaming: Bool
  let selectedSessionId: String
  let onToggleActivity: (ChatEntry) -> Void
  let onPermissionInput: (String, String) -> Void

  var body: some View {
    switch entry.role {
    case .user:
      UserMessageBubble(text: entry.text)
    case .assistant:
      AssistantMarkdownView(text: entry.text)
    case .system:
      Text(entry.text)
        .font(.body)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .tool, .command, .test, .plan, .diff, .permission, .artifact:
      ActivityCard(
        entry: entry,
        isExpanded: isExpanded,
        isStreaming: isStreaming,
        selectedSessionId: selectedSessionId,
        onToggleActivity: onToggleActivity,
        onPermissionInput: onPermissionInput
      )
    }
  }
}

private struct UserMessageBubble: View {
  let text: String

  var body: some View {
    HStack {
      Spacer(minLength: 48)
      Text(text)
        .font(.body)
        .foregroundStyle(.primary)
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color(.secondarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
  }
}

private struct AssistantMarkdownView: View {
  let text: String

  private var displayText: String {
    let limit = 12_000
    guard text.count > limit else { return text }
    return "内容较长，已显示最新部分：\n\n" + text.suffix(limit)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(AssistantMarkdownParser.blocks(from: displayText).prefix(120).enumerated()), id: \.offset) { _, block in
        switch block.kind {
        case .heading:
          Text(block.text)
            .font(.body.weight(.semibold))
            .foregroundStyle(.primary)
            .padding(.top, 2)
        case .bullet:
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•")
              .font(.body.weight(.semibold))
              .foregroundStyle(.secondary)
              .frame(width: 10, alignment: .leading)
            Text(block.text)
              .font(.body)
              .foregroundStyle(.primary)
              .fixedSize(horizontal: false, vertical: true)
          }
        case .orderedList(let marker):
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker)
              .font(.body.weight(.semibold))
              .foregroundStyle(.secondary)
              .monospacedDigit()
              .frame(minWidth: 22, alignment: .trailing)
            Text(block.text)
              .font(.body)
              .foregroundStyle(.primary)
              .fixedSize(horizontal: false, vertical: true)
          }
        case .paragraph:
          Text(block.text)
            .font(.body)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
        case .codeBlock(let language):
          CodeBlockCard(language: language, text: block.text)
        }
      }
    }
    .lineSpacing(3)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct CodeBlockCard: View {
  let language: String
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(language.isEmpty ? "Plain text" : language)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)

        Spacer()

        Button {
          UIPasteboard.general.string = text
        } label: {
          Image(systemName: "doc.on.doc")
            .font(.system(size: 16, weight: .semibold))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("复制代码")
      }

      ScrollView(.horizontal, showsIndicators: true) {
        Text(text)
          .font(.system(.callout, design: .monospaced))
          .foregroundStyle(.primary)
          .fixedSize(horizontal: true, vertical: false)
          .textSelection(.enabled)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(.secondarySystemBackground))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(Color(.separator).opacity(0.35), lineWidth: 1)
    }
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

private struct ActivityGroupCard: View {
  let group: ActivityGroup
  let isExpanded: Bool
  let expandedActivityEntryIds: Set<UUID>
  let isStreaming: Bool
  let selectedSessionId: String
  let onToggleGroup: (ActivityGroup) -> Void
  let onToggleActivity: (ChatEntry) -> Void
  let onPermissionInput: (String, String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        onToggleGroup(group)
      } label: {
        HStack(alignment: .center, spacing: 9) {
          Image(systemName: group.iconName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(group.tint)
            .frame(width: 20)

          Text("过程")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)

          Spacer(minLength: 8)

          Text(group.statusLabel)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .lineLimit(1)

          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(.secondarySystemBackground))
      .overlay {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(Color(.separator).opacity(0.28), lineWidth: 1)
      }
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

      if isExpanded {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(group.entries) { entry in
            ChatEntryView(
              entry: entry,
              isExpanded: isActivityExpanded(entry),
              isStreaming: isStreaming,
              selectedSessionId: selectedSessionId,
              onToggleActivity: onToggleActivity,
              onPermissionInput: onPermissionInput
            )
          }
        }
      }
    }
  }

  private func isActivityExpanded(_ entry: ChatEntry) -> Bool {
    if entry.status == "running" || entry.status == "waiting" {
      return true
    }
    return expandedActivityEntryIds.contains(entry.id)
  }
}

private struct ActivityCard: View {
  let entry: ChatEntry
  let isExpanded: Bool
  let isStreaming: Bool
  let selectedSessionId: String
  let onToggleActivity: (ChatEntry) -> Void
  let onPermissionInput: (String, String) -> Void

  private var canExpand: Bool {
    entry.isExpandableActivity
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        guard canExpand else { return }
        onToggleActivity(entry)
      } label: {
        activityCardHeader
      }
      .buttonStyle(.plain)
      .disabled(!canExpand)

      if isExpanded {
        activityCardDetails

        if entry.role == .permission, entry.status == "waiting" {
          HStack(spacing: 8) {
            Button("允许一次") {
              onPermissionInput("1", "允许一次")
            }
            Button("本次允许") {
              onPermissionInput("2", "本次允许")
            }
            Button("拒绝") {
              onPermissionInput("3", "拒绝")
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

  private var activityCardHeader: some View {
    HStack(alignment: .center, spacing: 9) {
      Image(systemName: entry.iconName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(entry.tint)
        .frame(width: 20)

      if isExpanded {
        VStack(alignment: .leading, spacing: 2) {
          Text(entry.cardTitle)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(2)
          if !entry.status.isEmpty {
            Text(entry.statusLabel)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      } else {
        Text(entry.cardTitle)
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
          Text(entry.statusLabel)
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
  private var activityCardDetails: some View {
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
}

private extension ActivityGroup {
  var statusLabel: String {
    let activityEntries = entries.filter { $0.role != .assistant }
    let stepCount = max(activityEntries.count, entries.count)
    let failedCount = activityEntries.filter { $0.status == "failed" }.count
    if failedCount > 0 {
      return "\(stepCount) 步 · \(failedCount) 失败"
    }
    if activityEntries.contains(where: { $0.status == "changed" }) {
      return "\(stepCount) 步 · 有变更"
    }
    return "已完成 \(stepCount) 步"
  }

  var iconName: String {
    let activityEntries = entries.filter { $0.role != .assistant }
    if activityEntries.contains(where: { $0.status == "failed" }) {
      return "xmark.circle.fill"
    }
    if activityEntries.contains(where: { $0.status == "changed" }) {
      return "doc.text.magnifyingglass"
    }
    return "checkmark.circle.fill"
  }

  var tint: Color {
    let activityEntries = entries.filter { $0.role != .assistant }
    if activityEntries.contains(where: { $0.status == "failed" }) {
      return .red
    }
    if activityEntries.contains(where: { $0.status == "changed" }) {
      return .purple
    }
    return .green
  }
}

private extension ChatEntry {
  var cardTitle: String {
    if !title.isEmpty {
      return title
    }
    if !target.isEmpty {
      return target
    }
    if !command.isEmpty {
      return command
    }
    return role.rawValue
  }

  var isExpandableActivity: Bool {
    switch role {
    case .tool, .command, .test, .plan, .diff, .artifact:
      return true
    case .permission:
      return status != "waiting"
    case .user, .assistant, .system:
      return false
    }
  }

  var iconName: String {
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

  var tint: Color {
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

  var statusLabel: String {
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
}
