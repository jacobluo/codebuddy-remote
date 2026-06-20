import XCTest
@testable import CodeBuddyRemote

final class ChatModelsTests: XCTestCase {
  func testDeviceCredentialSignatureMatchesHostHMAC() {
    let credential = DeviceCredential(
      deviceId: "device-1",
      deviceSecret: "secret-1",
      deviceName: "iPhone"
    )

    let signature = credential.signature(
      method: "GET",
      path: "/api/sessions",
      body: "",
      timestamp: "1000",
      nonce: "nonce-1"
    )

    XCTAssertEqual(signature, "zg0EYAezzych3RabhHipQ-2DLs7K-BH83fG7O1_3iTM")
  }

  func testDeviceCredentialRelayJoinSignatureMatchesRelayHMAC() {
    let credential = DeviceCredential(
      deviceId: "device-1",
      deviceSecret: "secret-1",
      deviceName: "iPhone"
    )

    let signature = credential.relayJoinSignature(
      pairingCode: "PAIR123",
      timestamp: "1000",
      nonce: "nonce-1"
    )

    XCTAssertEqual(signature, "218UVy9woW931dZKyDq5GSYA8uem-sO97qy7rrxkG8Q")
  }

  func testRelayE2EEncryptsPayloadsWithoutPlaintext() throws {
    let hostPeer = RelayE2EPeer(role: .host, pairingCode: "E2E1")
    let clientPeer = RelayE2EPeer(role: .client, pairingCode: "E2E1")
    try hostPeer.deriveSession(peerPublicKey: clientPeer.publicKey)
    try clientPeer.deriveSession(peerPublicKey: hostPeer.publicKey)

    let command: [String: Any] = [
      "type": "command",
      "id": "cmd-1",
      "sessionId": "local-host",
      "name": "listSessions",
      "payload": [:],
    ]

    let encrypted = try clientPeer.encryptPayload(command)
    let encryptedText = String(data: try JSONSerialization.data(withJSONObject: encrypted), encoding: .utf8)
    XCTAssertFalse(encryptedText?.contains("listSessions") ?? true)

    let decrypted = try hostPeer.decryptPayload(encrypted)
    XCTAssertEqual(decrypted["type"] as? String, "command")
    XCTAssertEqual(decrypted["name"] as? String, "listSessions")
  }

  func testPairingPayloadRejectsLocalURL() {
    XCTAssertThrowsError(
      try PairingPayload.parse(
        "cbr://pair?v=1&mode=local&baseURL=http%3A%2F%2F192.168.1.23%3A17320&bindToken=bind-once&workspace=drink&host=MacBook&expiresAt=2000",
        now: Date(timeIntervalSince1970: 1)
      )
    )
  }

  func testPairingPayloadParsesRelayURL() throws {
    let payload = try PairingPayload.parse(
      "cbr://pair?v=1&mode=relay&relayURL=wss%3A%2F%2Frelay.example.com%2Frelay&pairingCode=PAIR123&pairingSecret=pair-secret-12345&workspace=drink&host=MacBook&expiresAt=2000",
      now: Date(timeIntervalSince1970: 1)
    )

    XCTAssertEqual(payload.mode, .relay)
    XCTAssertEqual(payload.relayURL, "wss://relay.example.com/relay")
    XCTAssertEqual(payload.relayToken, "")
    XCTAssertEqual(payload.pairingCode, "PAIR123")
    XCTAssertEqual(payload.pairingSecret, "pair-secret-12345")
    XCTAssertEqual(payload.workspace, "drink")
    XCTAssertEqual(payload.host, "MacBook")
  }

  func testPairingPayloadRejectsExpiredURL() {
    XCTAssertThrowsError(
      try PairingPayload.parse(
        "cbr://pair?v=1&mode=local&baseURL=http%3A%2F%2F192.168.1.23%3A17320&token=local-token&expiresAt=1000",
        now: Date(timeIntervalSince1970: 2)
      )
    )
  }

  func testConversationItemsGroupCompletedActivityUntilFinalAssistantMessage() {
    let user = ChatEntry(id: UUID(), role: .user, text: "扫描代码")
    let thinking = ChatEntry(id: UUID(), role: .assistant, text: "我先读取项目结构。")
    let readTool = ChatEntry(id: UUID(), role: .tool, title: "Read", text: "Read 58 lines", status: "completed")
    let command = ChatEntry(id: UUID(), role: .command, title: "npm test", text: "40 tests passed", status: "passed")
    let answer = ChatEntry(id: UUID(), role: .assistant, text: "代码扫描完成，以下是项目概览：")
    let permission = ChatEntry(id: UUID(), role: .permission, title: "需要确认", status: "waiting")

    let items = ChatDisplayBuilder.conversationItems(from: [
      user,
      thinking,
      readTool,
      command,
      answer,
      permission,
    ])

    XCTAssertEqual(items.count, 4)

    guard case .entry(let first) = items[0] else {
      return XCTFail("Expected first item to be user entry")
    }
    XCTAssertEqual(first.id, user.id)

    guard case .activityGroup(let group) = items[1] else {
      return XCTFail("Expected completed work to be grouped")
    }
    XCTAssertEqual(group.entries.map(\.id), [thinking.id, readTool.id, command.id])

    guard case .entry(let finalAnswer) = items[2] else {
      return XCTFail("Expected final assistant answer to stay visible")
    }
    XCTAssertEqual(finalAnswer.id, answer.id)

    guard case .entry(let waitingPermission) = items[3] else {
      return XCTFail("Expected waiting permission to stay expanded")
    }
    XCTAssertEqual(waitingPermission.id, permission.id)
  }

  func testVisibleConversationItemsUseBoundedTailWithoutMutatingHistory() {
    let entries = makeLargeConversationEntries(turns: 300)

    let items = ChatDisplayBuilder.visibleConversationItems(from: entries, maxEntries: 80)

    XCTAssertEqual(entries.count, 1_200)
    XCTAssertLessThanOrEqual(items.flatMap(\.entries).count, 80)
    XCTAssertFalse(items.flatMap(\.entries).contains { $0.text == "请求 0" })
    XCTAssertTrue(items.flatMap(\.entries).contains { $0.text == "结果 299" })
  }

  func testVisibleConversationItemsBuildLargeHistoryWithinBoundedWork() {
    let entries = makeLargeConversationEntries(turns: 300)

    measure(metrics: [XCTClockMetric()]) {
      let items = ChatDisplayBuilder.visibleConversationItems(from: entries, maxEntries: 80)
      XCTAssertLessThanOrEqual(items.flatMap(\.entries).count, 80)
    }
  }

  func testAssistantMarkdownParserKeepsOrderedListsStructured() {
    let blocks = AssistantMarkdownParser.blocks(from: """
    功能特性：
    1. 定时提醒 - 按照设定间隔发送通知
    2. 今日统计 - 展示当天喝水次数
    - 设置持久化
    """)

    XCTAssertEqual(blocks.count, 4)
    assertHeading(blocks[0], "功能特性：")
    assertOrderedList(blocks[1], marker: "1.", text: "定时提醒 - 按照设定间隔发送通知")
    assertOrderedList(blocks[2], marker: "2.", text: "今日统计 - 展示当天喝水次数")
    assertBullet(blocks[3], "设置持久化")
  }

  func testAssistantMarkdownParserRendersTreesAsCodeBlocks() {
    let blocks = AssistantMarkdownParser.blocks(from: """
    当前代码结构如下：
    /Users/robiluo/aicoding/drink
    ├── Package.swift
    └── Sources
        └── DrinkWaterApp.swift
    后续可以清理重复目录。
    """)

    XCTAssertEqual(blocks.count, 3)
    assertHeading(blocks[0], "当前代码结构如下：")
    assertCodeBlock(blocks[1], language: "Plain text") { text in
      XCTAssertTrue(text.contains("Package.swift"))
      XCTAssertTrue(text.contains("DrinkWaterApp.swift"))
    }
    assertParagraph(blocks[2], "后续可以清理重复目录。")
  }

  func testAssistantMarkdownParserRendersFencedAndLikelySwiftCodeBlocks() {
    let fenced = AssistantMarkdownParser.blocks(from: """
    ```swift
    import SwiftUI
    struct Row: View {
    }
    ```
    """)
    XCTAssertEqual(fenced.count, 1)
    assertCodeBlock(fenced[0], language: "swift") { text in
      XCTAssertTrue(text.contains("import SwiftUI"))
      XCTAssertTrue(text.contains("struct Row"))
    }

    let inferred = AssistantMarkdownParser.blocks(from: """
    import SwiftUI
    struct Row: View {
    }
    """)
    XCTAssertEqual(inferred.count, 1)
    assertCodeBlock(inferred[0], language: "Swift") { text in
      XCTAssertTrue(text.contains("import SwiftUI"))
      XCTAssertTrue(text.contains("struct Row"))
    }
  }

  func testAssistantMarkdownParserRepairsSplitChineseHeading() {
    let blocks = AssistantMarkdownParser.blocks(from: """
    几个值得
    意的点：
    - 未设置 git remote
    """)

    XCTAssertEqual(blocks.count, 2)
    assertHeading(blocks[0], "几个值得注意的点：")
    assertBullet(blocks[1], "未设置 git remote")
  }

  private func assertParagraph(_ block: AssistantBlock, _ text: String, file: StaticString = #filePath, line: UInt = #line) {
    guard case .paragraph = block.kind else {
      return XCTFail("Expected paragraph", file: file, line: line)
    }
    XCTAssertEqual(block.text, text, file: file, line: line)
  }

  private func assertHeading(_ block: AssistantBlock, _ text: String, file: StaticString = #filePath, line: UInt = #line) {
    guard case .heading = block.kind else {
      return XCTFail("Expected heading", file: file, line: line)
    }
    XCTAssertEqual(block.text, text, file: file, line: line)
  }

  private func assertBullet(_ block: AssistantBlock, _ text: String, file: StaticString = #filePath, line: UInt = #line) {
    guard case .bullet = block.kind else {
      return XCTFail("Expected bullet", file: file, line: line)
    }
    XCTAssertEqual(block.text, text, file: file, line: line)
  }

  private func assertOrderedList(
    _ block: AssistantBlock,
    marker: String,
    text: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard case .orderedList(let actualMarker) = block.kind else {
      return XCTFail("Expected ordered list", file: file, line: line)
    }
    XCTAssertEqual(actualMarker, marker, file: file, line: line)
    XCTAssertEqual(block.text, text, file: file, line: line)
  }

  private func assertCodeBlock(
    _ block: AssistantBlock,
    language: String,
    file: StaticString = #filePath,
    line: UInt = #line,
    verify: (String) -> Void
  ) {
    guard case .codeBlock(let actualLanguage) = block.kind else {
      return XCTFail("Expected code block", file: file, line: line)
    }
    XCTAssertEqual(actualLanguage, language, file: file, line: line)
    verify(block.text)
  }

  private func makeLargeConversationEntries(turns: Int) -> [ChatEntry] {
    var entries: [ChatEntry] = []
    entries.reserveCapacity(turns * 4)
    for index in 0..<turns {
      entries.append(ChatEntry(id: UUID(), role: .user, text: "请求 \(index)"))
      entries.append(ChatEntry(id: UUID(), role: .assistant, text: "我先检查第 \(index) 轮。"))
      entries.append(ChatEntry(id: UUID(), role: .tool, title: "Read \(index)", status: "completed"))
      entries.append(ChatEntry(id: UUID(), role: .assistant, text: "结果 \(index)"))
    }
    return entries
  }
}
