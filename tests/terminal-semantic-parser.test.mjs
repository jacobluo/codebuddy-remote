import assert from "node:assert/strict";
import test from "node:test";

import { TerminalSemanticParser } from "../apps/local-host/src/terminal-semantic-parser.mjs";

test("terminal semantic parser extracts assistant, tool, command, test, permission, and diff events", () => {
  const parser = new TerminalSemanticParser();

  const events = parser.write(`
● Let me inspect the project before editing.
项目当前状态如下：
- 技术栈：SwiftUI
● Explore · Read(Sources/DrinkWater/App.swift)
● Search(pattern: "**/*.swift", path: ".")
  ⎿ Found 7 files
● Bash(npm test)
  ⎿ 32 tests passed
  ⎿ Tip: Use Plan Mode to prepare for a complex request before making changes.
● Edit(apps/ios/AppView.swift)
  ⎿ +24 additions -8 deletions
● Bash(xcrun simctl io booted screenshot /tmp/app.png)
  ⎿ Wrote screenshot to: /tmp/app.png
- [x] Add structured cards
✸ Waking… (2s · waiting for permission · ↑ 1.2k tokens · esc to interrupt)
● Bash(cd /Users/robiluo/aicoding/drink && npm test)
 Do you want to proceed?
`);

  assert.deepEqual(
    events.map((event) => [event.name, event.payload.kind, event.payload.title]),
    [
      ["assistant.delta", "assistant", "Assistant"],
      ["assistant.delta", "assistant", "Assistant"],
      ["assistant.delta", "assistant", "Assistant"],
      ["tool.requested", "tool", "Read"],
      ["tool.requested", "tool", "Search"],
      ["tool.output", "tool", "Found 7 files"],
      ["tool.requested", "command", "npm test"],
      ["tool.output", "test", "32 tests passed"],
      ["tool.requested", "edit", "apps/ios/AppView.swift"],
      ["diff.created", "diff", "apps/ios/AppView.swift"],
      ["tool.requested", "command", "xcrun simctl io booted screenshot /tmp/app.png"],
      ["tool.output", "artifact", "截图"],
      ["tool.output", "plan", "计划"],
      ["session.state", "status", "waiting_permission"],
      ["tool.requested", "command", "cd /Users/robiluo/aicoding/drink && npm test"],
      ["tool.permissionRequested", "permission", "需要确认：cd /Users/robiluo/aicoding/drink && npm test"],
      ["session.state", "status", "waiting_permission"],
    ]
  );
  assert.equal(events[1].payload.text, "项目当前状态如下：");
  assert.equal(events[2].payload.text, "- 技术栈：SwiftUI");
  assert.equal(events[3].payload.target, "Sources/DrinkWater/App.swift");
  assert.equal(events[6].payload.command, "npm test");
  assert.equal(events[9].payload.additions, 24);
  assert.equal(events[9].payload.deletions, 8);
  assert.equal(events[11].payload.target, "/tmp/app.png");
  assert.equal(events[15].payload.command, "cd /Users/robiluo/aicoding/drink && npm test");
});

test("terminal semantic parser filters CodeBuddy spinner redraws", () => {
  const parser = new TerminalSemanticParser();

  const events = parser.write(`
● Explore · Let me explore the project systematically.
  ⎿ ⠋ Explore · Explore current project state · running Glob
Press Shift+Tab twice to enable.
>
● Explore · Read(Sources/DrinkWater/App.swift)
  ⎿ ⠙ Explore · Explore current project state · waiting for permission · ↑ 4
Do you want to proceed?
`);

  assert.deepEqual(
    events.map((event) => [event.name, event.payload.kind, event.payload.title, event.payload.text]),
    [
      ["assistant.delta", "assistant", "Assistant", "Let me explore the project systematically."],
      ["tool.requested", "tool", "Read", "Sources/DrinkWater/App.swift"],
      ["session.state", "status", "waiting_permission", "⎿ ⠙ Explore · Explore current project state · waiting for permission · ↑ 4"],
      ["tool.permissionRequested", "permission", "需要确认：Read", "Do you want to proceed?"],
      ["session.state", "status", "waiting_permission", "Do you want to proceed?"],
    ]
  );
});

test("terminal semantic parser strips inline CodeBuddy tips from assistant text", () => {
  const parser = new TerminalSemanticParser();

  const events = parser.write("● ok-result ⎿ Tip: Use Plan Mode to prepare for a complex request before making changes.\n");

  assert.equal(events.length, 1);
  assert.equal(events[0].name, "assistant.delta");
  assert.equal(events[0].payload.text, "ok-result");
});

test("terminal semantic parser does not emit duplicate semantic events for redrawn lines", () => {
  const parser = new TerminalSemanticParser();

  const first = parser.write("● Bash(npm test)\n  ⎿ 32 tests passed\n");
  const second = parser.write("● Bash(npm test)\n  ⎿ 32 tests passed\n");

  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});
