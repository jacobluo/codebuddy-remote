import assert from "node:assert/strict";
import test from "node:test";

import {
  ServeCliAdapter,
  extractAssistantText,
  parseSseMessages,
} from "../apps/local-host/src/adapters/serve-cli-adapter.mjs";

test("parses ACP SSE message payloads", () => {
  const messages = parseSseMessages(`:ok

event: message
data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"O"}}}}

event: message
data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"K"}}}}

event: message
data: {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}

`);

  assert.equal(messages.length, 3);
  assert.equal(extractAssistantText(messages), "OK");
});

test("serve CLI adapter initializes once and reuses the same ACP session", async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(["connect"]);
      return { connectionId: "conn_1" };
    },
    async initialize() {
      calls.push(["initialize"]);
      return {};
    },
    async newSession() {
      calls.push(["newSession"]);
      return { sessionId: "acp_session_1" };
    },
    async prompt(sessionId, text) {
      calls.push(["prompt", sessionId, text]);
      const promptCount = calls.filter((call) => call[0] === "prompt").length;
      return {
        messages: [
          {
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: promptCount === 1 ? "已记住" : "grape-remote-73" },
              },
            },
          },
        ],
      };
    },
  };

  const adapter = new ServeCliAdapter({
    cwd: "/tmp/workspace",
    startServer: async () => ({ close() {} }),
    createClient: () => fakeClient,
  });

  const first = await adapter.sendPrompt("serve-cli", "请记住暗号 grape-remote-73");
  const second = await adapter.sendPrompt("serve-cli", "刚才暗号是什么？");

  assert.equal(first.conversationId, "acp_session_1");
  assert.equal(first.assistantText, "已记住");
  assert.equal(second.conversationId, "acp_session_1");
  assert.equal(second.assistantText, "grape-remote-73");
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["connect", "initialize", "newSession", "prompt", "prompt"]
  );
});

test("serve CLI adapter can start CodeBuddy in foreground interactive mode before prompts", async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(["connect"]);
    },
    async initialize() {
      calls.push(["initialize"]);
    },
    async newSession() {
      calls.push(["newSession"]);
      return { sessionId: "acp_session_foreground" };
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };

  const adapter = new ServeCliAdapter({
    cwd: "/tmp/workspace",
    stdio: "inherit",
    startServer: async (args) => {
      calls.push(["startServer", args]);
      return { close: () => calls.push(["close"]) };
    },
    createClient: () => fakeClient,
  });

  await adapter.start();

  assert.equal(calls[0][0], "startServer");
  assert.equal(calls[0][1].stdio, "inherit");
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["startServer", "connect", "initialize", "newSession"]
  );
  assert.deepEqual(adapter.getState("serve-cli"), {
    sessionId: "serve-cli",
    source: "cli-serve",
    workspace: "/tmp/workspace",
    status: "idle",
    conversationId: "acp_session_foreground",
  });

  await adapter.close();
});
