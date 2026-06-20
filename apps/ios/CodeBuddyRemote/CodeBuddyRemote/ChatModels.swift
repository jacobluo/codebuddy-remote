import Foundation

struct ChatEntry: Identifiable, Codable, Equatable {
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

struct ActivityGroup: Identifiable {
  let id: UUID
  var entries: [ChatEntry]
}

enum ConversationItem: Identifiable {
  case entry(ChatEntry)
  case activityGroup(ActivityGroup)

  var id: UUID {
    switch self {
    case .entry(let entry):
      entry.id
    case .activityGroup(let group):
      group.id
    }
  }
}

struct AssistantBlock {
  enum Kind {
    case paragraph
    case heading
    case bullet
    case orderedList(marker: String)
    case codeBlock(language: String)
  }

  var kind: Kind
  var text: String
}

enum ChatDisplayBuilder {
  static func conversationItems(from entries: [ChatEntry]) -> [ConversationItem] {
    var items: [ConversationItem] = []
    var pendingActivities: [ChatEntry] = []

    func flushPendingActivities() {
      guard !pendingActivities.isEmpty else { return }
      items.append(.activityGroup(ActivityGroup(id: pendingActivities[0].id, entries: pendingActivities)))
      pendingActivities.removeAll()
    }

    for entry in entries {
      if isCollapsedIntoActivityGroup(entry) {
        pendingActivities.append(entry)
      } else {
        flushPendingActivities()
        items.append(.entry(entry))
      }
    }

    flushPendingActivities()
    return items
  }

  static func isCollapsedIntoActivityGroup(_ entry: ChatEntry) -> Bool {
    switch entry.role {
    case .tool, .command, .test, .plan, .diff, .permission, .artifact:
      return entry.status != "running" && entry.status != "waiting"
    case .assistant:
      return isIntermediateAssistantMessage(entry.text)
    case .user, .system:
      return false
    }
  }

  static func isIntermediateAssistantMessage(_ text: String) -> Bool {
    let normalized = text
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()

    guard normalized.count <= 260 else { return false }

    let prefixes = [
      "let me ",
      "now let me ",
      "i'll ",
      "i will ",
      "good --",
      "good,",
      "接下来",
      "我先",
      "我来",
      "让我",
    ]
    guard prefixes.contains(where: { normalized.hasPrefix($0) }) else {
      return false
    }

    let processWords = [
      "explore",
      "read",
      "check",
      "gather",
      "inspect",
      "analyze",
      "look at",
      "run",
      "查看",
      "读取",
      "检查",
      "分析",
      "探索",
    ]
    return processWords.contains(where: { normalized.contains($0) })
  }
}

enum AssistantMarkdownParser {
  static func blocks(from text: String) -> [AssistantBlock] {
    var blocks: [AssistantBlock] = []
    var codeBuffer: [String] = []
    var codeLanguage = "Plain text"
    var isInFence = false

    func flushCodeBlock() {
      guard !codeBuffer.isEmpty else { return }
      blocks.append(AssistantBlock(kind: .codeBlock(language: codeLanguage), text: codeBuffer.joined(separator: "\n")))
      codeBuffer.removeAll()
      codeLanguage = "Plain text"
    }

    let lines = text.components(separatedBy: .newlines)
    for index in lines.indices {
      let line = cleanDisplayLine(lines[index])
      let nextLine = index < lines.index(before: lines.endIndex) ? cleanDisplayLine(lines[lines.index(after: index)]) : ""

      if line.hasPrefix("```") {
        if isInFence {
          flushCodeBlock()
          isInFence = false
        } else {
          isInFence = true
          let language = line.dropFirst(3).trimmingCharacters(in: .whitespacesAndNewlines)
          codeLanguage = language.isEmpty ? "Plain text" : String(language)
        }
        continue
      }

      if isInFence {
        codeBuffer.append(line)
        continue
      }

      if shouldRenderAsCodeLine(line, nextLine: nextLine) {
        if codeBuffer.isEmpty, isLikelyCodeLine(line) {
          codeLanguage = "Swift"
        }
        codeBuffer.append(line)
        continue
      } else {
        flushCodeBlock()
      }

      guard !line.isEmpty else { continue }

      if line == "意的点：" || line == "意的点:" {
        if let last = blocks.indices.last, blocks[last].text.hasSuffix("几个值得") {
          blocks[last].text.removeLast("几个值得".count)
          blocks[last].text = blocks[last].text.trimmingCharacters(in: .whitespacesAndNewlines)
          if blocks[last].text.isEmpty {
            blocks.remove(at: last)
          }
          blocks.append(AssistantBlock(kind: .heading, text: "几个值得注意的点："))
          continue
        }
      }

      if let orderedList = orderedListItem(from: line) {
        blocks.append(AssistantBlock(kind: .orderedList(marker: orderedList.marker), text: orderedList.text))
        continue
      }

      if let bulletText = bulletText(from: line) {
        blocks.append(AssistantBlock(kind: .bullet, text: bulletText))
        continue
      }

      if isHeading(line) {
        blocks.append(AssistantBlock(kind: .heading, text: headingText(line)))
        continue
      }

      if let last = blocks.indices.last {
        switch blocks[last].kind {
        case .paragraph, .bullet, .orderedList:
          blocks[last].text = "\(blocks[last].text) \(line)"
        case .heading, .codeBlock:
          blocks.append(AssistantBlock(kind: .paragraph, text: line))
        }
      } else {
        blocks.append(AssistantBlock(kind: .paragraph, text: line))
      }
    }

    flushCodeBlock()
    return blocks
  }

  private static func cleanDisplayLine(_ line: String) -> String {
    line
      .replacingOccurrences(of: "\u{FFFD}", with: "")
      .replacingOccurrences(of: "几个值得意的点", with: "几个值得注意的点")
      .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func shouldRenderAsCodeLine(_ line: String, nextLine: String) -> Bool {
    if line.isEmpty { return false }
    if line.contains("├") || line.contains("└") || line.contains("│") || line.contains("─") {
      return true
    }
    if nextLine.contains("├") || nextLine.contains("└") || nextLine.contains("│") {
      return line.hasSuffix("/") || line.hasPrefix("/")
    }
    if isLikelyCodeLine(line) {
      return true
    }
    return false
  }

  private static func isLikelyCodeLine(_ line: String) -> Bool {
    let patterns = [
      #"^import\s+[A-Za-z_][A-Za-z0-9_]*$"#,
      #"^(@[A-Za-z_][A-Za-z0-9_]*|struct\s+|class\s+|enum\s+|protocol\s+|extension\s+|func\s+|var\s+|let\s+|if\s+|for\s+|while\s+|switch\s+|case\s+|return\b)"#,
      #"^[A-Za-z_][A-Za-z0-9_]*\((.*)\)$"#,
      #"^\.[A-Za-z_][A-Za-z0-9_]*\((.*)\)$"#,
      #"^\}?$"#,
    ]

    return patterns.contains { pattern in
      line.range(of: pattern, options: .regularExpression) != nil
    }
  }

  private static func bulletText(from line: String) -> String? {
    let patterns = [
      #"^[-•]\s+(.+)$"#,
    ]

    for pattern in patterns {
      guard let range = line.range(of: pattern, options: .regularExpression) else {
        continue
      }
      let matched = String(line[range])
      if let textRange = matched.range(of: #"^([-•]|\d+[.)])\s+"#, options: .regularExpression) {
        return String(matched[textRange.upperBound...])
          .trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }

    return nil
  }

  private static func orderedListItem(from line: String) -> (marker: String, text: String)? {
    guard let markerRange = line.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) else {
      return nil
    }

    let marker = String(line[markerRange])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let text = String(line[markerRange.upperBound...])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return nil }
    return (marker, text)
  }

  private static func isHeading(_ line: String) -> Bool {
    if line.hasPrefix("#") { return true }
    guard line.count <= 28 else { return false }
    return line.hasSuffix("：") || line.hasSuffix(":")
  }

  private static func headingText(_ line: String) -> String {
    line
      .replacingOccurrences(of: #"^#{1,6}\s*"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
