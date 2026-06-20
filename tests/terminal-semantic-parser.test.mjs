import assert from "node:assert/strict";
import test from "node:test";

import { TerminalSemanticParser } from "../apps/local-host/src/terminal-semantic-parser.mjs";

test("terminal semantic parser extracts assistant, tool, command, test, permission, and diff events", () => {
  const parser = new TerminalSemanticParser();

  const events = parser.write(`
● Let me inspect the project before editing.
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
      ["tool.requested", "tool", "Search"],
      ["tool.output", "tool", "Found 7 files"],
      ["tool.requested", "command", "npm test"],
      ["tool.output", "test", "32 tests passed"],
      ["tool.requested", "edit", "apps/ios/AppView.swift"],
      ["diff.created", "diff", "apps/ios/AppView.swift"],
      ["tool.requested", "command", "xcrun simctl io booted screenshot /tmp/app.png"],
      ["tool.output", "artifact", "截图"],
      ["tool.output", "plan", "计划"],
      ["tool.permissionRequested", "permission", "等待权限"],
      ["session.state", "status", "waiting_permission"],
      ["tool.requested", "command", "cd /Users/robiluo/aicoding/drink && npm test"],
      ["tool.permissionRequested", "permission", "需要确认：cd /Users/robiluo/aicoding/drink && npm test"],
      ["session.state", "status", "waiting_permission"],
    ]
  );
  assert.equal(events[3].payload.command, "npm test");
  assert.equal(events[6].payload.additions, 24);
  assert.equal(events[6].payload.deletions, 8);
  assert.equal(events[8].payload.target, "/tmp/app.png");
  assert.equal(events[13].payload.command, "cd /Users/robiluo/aicoding/drink && npm test");
});

test("terminal semantic parser does not emit duplicate semantic events for redrawn lines", () => {
  const parser = new TerminalSemanticParser();

  const first = parser.write("● Bash(npm test)\n  ⎿ 32 tests passed\n");
  const second = parser.write("● Bash(npm test)\n  ⎿ 32 tests passed\n");

  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});
