import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalCliAdapter,
  startPythonPtyTerminal,
} from "../apps/local-host/src/terminal-cli-adapter.mjs";

test("terminal CLI adapter starts the real codebuddy command through a PTY wrapper", async () => {
  const calls = [];
  const adapter = new TerminalCliAdapter({
    cwd: "/tmp/workspace",
    startTerminal: async (options) => {
      calls.push(["startTerminal", options]);
      return {
        write: (text) => calls.push(["write", text]),
        close: () => calls.push(["close"]),
        closed: new Promise(() => {}),
      };
    },
  });

  await adapter.start();

  assert.equal(calls[0][0], "startTerminal");
  assert.equal(calls[0][1].cliPath, "codebuddy");
  assert.deepEqual(calls[0][1].args, []);
  assert.equal(calls[0][1].cwd, "/tmp/workspace");
  assert.deepEqual(adapter.listSessions(), [
    {
      id: "terminal-cli",
      source: "cli-terminal",
      workspace: "/tmp/workspace",
      state: "interactive",
    },
  ]);
});

test("terminal CLI adapter writes phone prompts into the same terminal session", async () => {
  const calls = [];
  const adapter = new TerminalCliAdapter({
    cwd: "/tmp/workspace",
    submitDelayMs: 0,
    startTerminal: async () => ({
      write: (text) => calls.push(["write", text]),
      close: () => calls.push(["close"]),
      closed: new Promise(() => {}),
    }),
  });

  const result = await adapter.sendPrompt("terminal-cli", "只回复 OK");

  assert.deepEqual(calls, [
    ["write", "只回复 OK"],
    ["write", "\r"],
  ]);
  assert.equal(result.conversationId, "terminal-cli");
  assert.equal(result.terminalOnly, true);
});

test("terminal CLI adapter emits terminal output chunks as normalized events", async () => {
  let onData;
  const events = [];
  const adapter = new TerminalCliAdapter({
    cwd: "/tmp/workspace",
    startTerminal: async (options) => {
      onData = options.onData;
      return {
        write: () => {},
        close: () => {},
        closed: new Promise(() => {}),
      };
    },
  });
  adapter.onEvent((event) => events.push(event));

  await adapter.start();
  onData("CodeBuddy ready");

  assert.deepEqual(events, [
    {
      sessionId: "terminal-cli",
      conversationId: "terminal-cli",
      name: "terminal.output",
      payload: { text: "CodeBuddy ready" },
    },
  ]);
});

test("python PTY bridge can run a simple terminal command", async () => {
  let output = "";
  const terminal = await startPythonPtyTerminal({
    cliPath: "/bin/echo",
    args: ["PTY_OK"],
    cwd: process.cwd(),
    input: null,
    output: { write: (chunk) => { output += chunk; } },
    errorOutput: { write: (chunk) => { output += chunk; } },
    env: process.env,
    onData: () => {},
  });

  await terminal.closed;

  assert.match(output, /PTY_OK/);
});
