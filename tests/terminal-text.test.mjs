import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalScreen,
  normalizeTerminalOutput,
  terminalOutputLabel,
} from "../apps/mobile-web/public/terminal-text.js";

test("normalizes ANSI colored terminal output for browser display", () => {
  const input = "\x1b[38;2;184;191;197m● \x1b[39m\x1b[1mBash\x1b[22m \x1b[38;2;184;191;197m(ls -la)\x1b[39m";

  assert.equal(normalizeTerminalOutput(input), "● Bash (ls -la)");
});

test("normalizes terminal repaint and cursor movement sequences", () => {
  const input = "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[38;2;184;191;197m? for shortcuts\x1b[39m\r\n";

  assert.equal(normalizeTerminalOutput(input), "? for shortcuts");
});

test("normalizes copied CSI fragments where ESC was already stripped", () => {
  const input = "[38;2;184;191;197m✶ Waking... [39m [38;2;184;191;197m(0s · waiting for permission)[39m";

  assert.equal(normalizeTerminalOutput(input), "✶ Waking... (0s · waiting for permission)");
});

test("drops terminal repaint chunks that contain no readable content", () => {
  assert.equal(normalizeTerminalOutput("\x1b[2K\x1b[1A\x1b[?25l"), "");
  assert.equal(terminalOutputLabel("\x1b[2K\x1b[1A"), "");
});

test("terminal screen updates in place instead of appending repaint chunks", () => {
  const screen = new TerminalScreen();

  screen.write("first line\nsecond line");
  screen.write("\x1b[1A\x1b[2Kupdated first");

  assert.equal(screen.toString(), "updated first\nsecond line");
});

test("terminal screen handles carriage-return status updates", () => {
  const screen = new TerminalScreen();

  screen.write("✶ Waking... (0s)");
  screen.write("\r\x1b[2K● DONE");

  assert.equal(screen.toString(), "● DONE");
});
