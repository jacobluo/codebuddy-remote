import assert from "node:assert/strict";
import test from "node:test";

import {
  RealCliAdapter,
  parseStreamJsonLines,
} from "../apps/local-host/src/real-cli-adapter.mjs";

test("parses stream-json result and session id from real CodeBuddy output", () => {
  const parsed = parseStreamJsonLines([
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session_real",
      cwd: "/tmp/workspace",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: "session_real",
      message: {
        content: [{ type: "text", text: "ignored when result exists" }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "session_real",
      result: "OK",
    }),
  ]);

  assert.equal(parsed.sessionId, "session_real");
  assert.equal(parsed.resultText, "OK");
  assert.equal(parsed.status, "success");
});

test("real CLI adapter invokes codebuddy print mode with stream-json", async () => {
  const calls = [];
  const adapter = new RealCliAdapter({
    cliPath: "codebuddy",
    cwd: "/tmp/workspace",
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "session_real",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "session_real",
          result: "OK",
        }),
      ].join("\n");
    },
  });

  const result = await adapter.sendPrompt("real-cli", "只回复 OK");

  assert.equal(result.conversationId, "session_real");
  assert.equal(result.assistantText, "OK");
  assert.equal(calls[0].command, "codebuddy");
  assert.deepEqual(calls[0].args, [
    "-p",
    "--output-format",
    "stream-json",
    "--max-turns",
    "1",
    "只回复 OK",
  ]);
  assert.equal(calls[0].options.cwd, "/tmp/workspace");
});

test("real CLI adapter exposes a single local CLI session", () => {
  const adapter = new RealCliAdapter({ cwd: "/tmp/workspace" });

  assert.deepEqual(adapter.listSessions(), [
    {
      id: "real-cli",
      source: "cli",
      workspace: "/tmp/workspace",
      state: "idle",
    },
  ]);
  assert.equal(adapter.getState("real-cli").status, "idle");
});

test("real CLI adapter reuses the remote CodeBuddy session id across turns", async () => {
  const calls = [];
  const adapter = new RealCliAdapter({
    cliPath: "codebuddy",
    cwd: "/tmp/workspace",
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "remote_session_1",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "remote_session_1",
          result: calls.length === 1 ? "已记住" : "banana-remote-42",
        }),
      ].join("\n");
    },
  });

  await adapter.sendPrompt("real-cli", "请记住暗号 banana-remote-42");
  await adapter.sendPrompt("real-cli", "刚才暗号是什么？");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes("--session-id"), false);
  assert.deepEqual(calls[1].args.slice(5, 7), ["--session-id", "remote_session_1"]);
});
