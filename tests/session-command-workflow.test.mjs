import assert from "node:assert/strict";
import test from "node:test";

import { createSessionCommandWorkflow } from "../apps/local-host/src/session-command-workflow.mjs";
import { MockCliAdapter } from "../apps/local-host/src/mock-cli-adapter.mjs";

test("sendPrompt records normalized user assistant and state events", async () => {
  const workflow = createSessionCommandWorkflow({
    adapter: new MockCliAdapter(),
  });

  const result = await workflow.handleCommand({
    type: "command",
    id: "cmd_prompt",
    sessionId: "mock-session",
    name: "sendPrompt",
    payload: { text: "只回复 OK" },
  });

  assert.equal(result.command.id, "cmd_prompt");
  assert.deepEqual(
    workflow.getEvents().map((event) => event.name),
    ["user.message", "session.state", "assistant.delta", "assistant.completed", "session.state"]
  );
  assert.equal(workflow.getEvents()[0].payload.text, "只回复 OK");
  assert.equal(workflow.getEvents()[2].payload.text, "OK");
});

test("terminal-only prompts do not create empty assistant messages", async () => {
  const workflow = createSessionCommandWorkflow({
    adapter: {
      listSessions() {
        return [{ id: "terminal-cli", source: "cli-terminal", workspace: "mock", state: "interactive" }];
      },
      getState() {
        return { sessionId: "terminal-cli", source: "cli-terminal", workspace: "mock", status: "interactive" };
      },
      onEvent() {},
      async sendPrompt() {
        return { conversationId: "terminal-cli", terminalOnly: true, assistantText: "", status: "interactive" };
      },
      async interrupt() {
        return this.getState();
      },
      async resume() {
        return this.getState();
      },
    },
  });

  await workflow.handleCommand({
    type: "command",
    id: "cmd_terminal_only",
    sessionId: "terminal-cli",
    name: "sendPrompt",
    payload: { text: "hello" },
  });

  assert.deepEqual(
    workflow.getEvents().map((event) => event.name),
    ["user.message", "session.state", "session.state"]
  );
  assert.equal(workflow.getEvents()[2].payload.status, "interactive");
});

test("sendTerminalInput validates controls and records permission resolution", async () => {
  let rawInput = "";
  const workflow = createSessionCommandWorkflow({
    adapter: {
      listSessions() {
        return [{ id: "terminal-cli", source: "cli-terminal", workspace: "mock", state: "interactive" }];
      },
      getState() {
        return { sessionId: "terminal-cli", source: "cli-terminal", workspace: "mock", status: "interactive" };
      },
      onEvent() {},
      async sendPrompt() {
        throw new Error("sendPrompt should not be used");
      },
      async sendTerminalInput(_sessionId, text) {
        rawInput = text;
        return { conversationId: "terminal-cli", terminalOnly: true, status: "interactive" };
      },
      async interrupt() {
        return this.getState();
      },
      async resume() {
        return this.getState();
      },
    },
  });

  await workflow.handleCommand({
    type: "command",
    id: "cmd_input",
    sessionId: "terminal-cli",
    name: "sendTerminalInput",
    payload: { text: "1", label: "允许一次" },
  });

  assert.equal(rawInput, "1");
  assert.deepEqual(
    workflow.getEvents().map((event) => event.name),
    ["tool.permissionResolved", "session.state"]
  );
  assert.equal(workflow.getEvents()[0].payload.title, "允许一次");

  await assert.rejects(
    workflow.handleCommand({
      type: "command",
      id: "cmd_bad_input",
      sessionId: "terminal-cli",
      name: "sendTerminalInput",
      payload: { text: "rm -rf", label: "bad" },
    }),
    /terminal input must be a single approved control key/
  );
});

test("listEvents supports after before and limit over the same event stream", async () => {
  const workflow = createSessionCommandWorkflow({
    adapter: new MockCliAdapter(),
  });

  for (let index = 1; index <= 5; index += 1) {
    workflow.pushEvent({
      sessionId: "mock-session",
      name: "assistant.delta",
      payload: { text: `message-${index}` },
    });
  }

  assert.deepEqual(
    workflow.getEvents({ after: 0, limit: 2 }).map((event) => event.payload.text),
    ["message-4", "message-5"]
  );

  const result = await workflow.handleCommand({
    type: "command",
    id: "cmd_list_events",
    sessionId: "local-host",
    name: "listEvents",
    payload: { before: 5, limit: 2 },
  });

  assert.equal(result.latestSeq, 5);
  assert.deepEqual(
    result.events.map((event) => event.payload.text),
    ["message-3", "message-4"]
  );
});

test("adapter events enter the same sequenced event stream", () => {
  let emitAdapterEvent;
  const workflow = createSessionCommandWorkflow({
    adapter: {
      listSessions() {
        return [];
      },
      getState() {
        return {};
      },
      onEvent(subscriber) {
        emitAdapterEvent = subscriber;
      },
    },
  });

  emitAdapterEvent({
    sessionId: "terminal-cli",
    conversationId: "terminal-cli",
    name: "terminal.output",
    payload: { text: "CodeBuddy ready" },
  });

  const events = workflow.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].name, "terminal.output");
  assert.equal(events[0].payload.text, "CodeBuddy ready");
});
