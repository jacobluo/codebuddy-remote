import Foundation

struct TerminalScreen {
  private var lines: [String] = [""]
  private var row = 0
  private var column = 0
  private let maxLines: Int

  init(maxLines: Int = 180) {
    self.maxLines = maxLines
  }

  mutating func write(_ chunk: String) {
    let scalars = Array(chunk.unicodeScalars)
    var index = 0

    while index < scalars.count {
      let scalar = scalars[index]

      if scalar.value == 0x1B, index + 1 < scalars.count, scalars[index + 1] == "[" {
        if let parsed = parseCSI(scalars: scalars, start: index + 2) {
          applyCSI(params: parsed.params, command: parsed.command)
          index = parsed.end + 1
          continue
        }
      }

      if scalar == "\r" {
        column = 0
        index += 1
        continue
      }

      if scalar == "\n" {
        row += 1
        column = 0
        ensureLine()
        trimScrollback()
        index += 1
        continue
      }

      if scalar.value < 0x20 || (0x7F...0x9F).contains(scalar.value) {
        index += 1
        continue
      }

      put(String(scalar))
      index += 1
    }
  }

  var text: String {
    lines
      .map { cleanLine($0) }
      .joined(separator: "\n")
      .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var assistantMessages: [String] {
    var messages: [String] = []
    var current: [String] = []

    func flush() {
      let text = current
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty {
        messages.append(text)
      }
      current.removeAll()
    }

    for rawLine in text.components(separatedBy: .newlines) {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("● ") {
        flush()
        let firstLine = String(line.dropFirst(2))
          .trimmingCharacters(in: .whitespaces)
        if shouldKeepAssistantLine(firstLine) {
          current.append(firstLine)
        }
        continue
      }

      guard !current.isEmpty else { continue }
      if shouldKeepAssistantLine(line) {
        current.append(line)
      } else if isTerminalBoundary(line) {
        flush()
      }
    }

    flush()
    return messages
  }

  private mutating func put(_ character: String) {
    ensureLine()
    let line = lines[row]
    let padded = line.padding(toLength: max(column + 1, line.count), withPad: " ", startingAt: 0)
    let start = padded.index(padded.startIndex, offsetBy: column)
    let end = padded.index(after: start)
    lines[row] = String(padded[..<start]) + character + String(padded[end...])
    column += 1
  }

  private mutating func ensureLine() {
    while lines.count <= row {
      lines.append("")
    }
  }

  private mutating func trimScrollback() {
    guard lines.count > maxLines else { return }
    let overflow = lines.count - maxLines
    lines.removeFirst(overflow)
    row = max(0, row - overflow)
  }

  private mutating func applyCSI(params: String, command: UnicodeScalar) {
    let first = Int(params.replacingOccurrences(of: "?", with: "").split(separator: ";").first ?? "0") ?? 0

    switch command {
    case "A":
      row = max(0, row - max(first, 1))
      ensureLine()
    case "B":
      row += max(first, 1)
      ensureLine()
    case "G":
      column = max(0, max(first, 1) - 1)
    case "H", "f":
      let parts = params.split(separator: ";")
      row = max(0, (Int(parts.first ?? "1") ?? 1) - 1)
      column = max(0, (Int(parts.dropFirst().first ?? "1") ?? 1) - 1)
      ensureLine()
    case "K":
      ensureLine()
      if first == 2 {
        lines[row] = ""
      } else if first == 1 {
        lines[row] = String(lines[row].dropFirst(min(column, lines[row].count)))
      } else {
        lines[row] = String(lines[row].prefix(min(column, lines[row].count)))
      }
    case "J":
      if first == 2 || first == 3 {
        lines = [""]
        row = 0
        column = 0
      }
    default:
      break
    }
  }

  private func parseCSI(scalars: [UnicodeScalar], start: Int) -> (params: String, command: UnicodeScalar, end: Int)? {
    var index = start
    while index < scalars.count {
      let value = scalars[index].value
      if value >= 0x40, value <= 0x7E {
        let params = String(String.UnicodeScalarView(scalars[start..<index]))
          .replacingOccurrences(of: #"[ -/]"#, with: "", options: .regularExpression)
        return (params, scalars[index], index)
      }
      index += 1
    }
    return nil
  }

  private func cleanLine(_ line: String) -> String {
    line
      .replacingOccurrences(of: #"\u{1B}\][\s\S]*?(\u{7}|\u{1B}\\)"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\u{1B}\[[0-?]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\[[?0-9;]*[ -/]*[@-~]"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
  }

  private func shouldKeepAssistantLine(_ line: String) -> Bool {
    if line.isEmpty { return false }
    if isTerminalBoundary(line) { return false }
    if line.hasPrefix("Bash(") || line.hasPrefix("Read(") || line.hasPrefix("Search(") {
      return false
    }
    if line.hasPrefix("⎿ ") { return false }
    if line.contains("Waking…") { return false }
    if line.contains("esc to interrupt") { return false }
    return true
  }

  private func isTerminalBoundary(_ line: String) -> Bool {
    if line.isEmpty { return true }
    if line.hasPrefix(">") { return true }
    if line == "? for shortcuts" { return true }
    if line.allSatisfy({ $0 == "─" || $0 == "━" || $0 == " " }) { return true }
    if line.hasPrefix("╭") || line.hasPrefix("╰") || line.hasPrefix("│") {
      return true
    }
    return false
  }
}
