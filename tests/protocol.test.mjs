import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_NAMES,
  EVENT_NAMES,
  createCommand,
  createEvent,
  validateCommand,
  validateEvent,
} from "../packages/protocol/src/index.mjs";

test("creates a valid sendPrompt command with a generated id", () => {
  const command = createCommand({
    sessionId: "session_1",
    name: "sendPrompt",
    payload: { text: "继续上一个任务", mode: "craft" },
  });

  assert.equal(command.type, "command");
  assert.equal(command.name, "sendPrompt");
  assert.equal(command.sessionId, "session_1");
  assert.match(command.id, /^cmd_/);
  assert.doesNotThrow(() => validateCommand(command));
});

test("creates a valid terminal input command", () => {
  const command = createCommand({
    sessionId: "session_1",
    name: "sendTerminalInput",
    payload: { text: "1", label: "允许一次" },
  });

  assert.equal(command.name, "sendTerminalInput");
  assert.equal(command.payload.text, "1");
  assert.doesNotThrow(() => validateCommand(command));
});

test("rejects unknown commands and events", () => {
  assert.ok(COMMAND_NAMES.has("interrupt"));
  assert.ok(EVENT_NAMES.has("assistant.delta"));

  assert.throws(
    () =>
      validateCommand({
        type: "command",
        id: "cmd_bad",
        sessionId: "session_1",
        name: "shell",
        payload: {},
      }),
    /unknown command/
  );

  assert.throws(
    () =>
      validateEvent({
        type: "event",
        id: "evt_bad",
        sessionId: "session_1",
        seq: 1,
        name: "agent.telepathy",
        payload: {},
      }),
    /unknown event/
  );
});

test("creates sequential events with expected metadata", () => {
  const event = createEvent({
    sessionId: "session_1",
    conversationId: "chat_1",
    seq: 7,
    name: "assistant.delta",
    payload: { text: "正在检查文件..." },
  });

  assert.equal(event.type, "event");
  assert.equal(event.id, "evt_7");
  assert.equal(event.seq, 7);
  assert.equal(event.conversationId, "chat_1");
  assert.doesNotThrow(() => validateEvent(event));
});
