import assert from "node:assert/strict";
import test from "node:test";

import { createLocalHost } from "../apps/local-host/src/local-host.mjs";
import { MockCliAdapter } from "../apps/local-host/src/mock-cli-adapter.mjs";

async function withHost(testFn) {
  const adapter = new MockCliAdapter();
  const host = createLocalHost({ adapter, token: "test-token" });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await testFn({ baseUrl, host });
  } finally {
    await host.close();
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

test("lists sessions and returns local host state", async () => {
  await withHost(async ({ baseUrl }) => {
    const sessions = await requestJson(`${baseUrl}/api/sessions`);
    assert.equal(sessions.response.status, 200);
    assert.deepEqual(sessions.body.sessions, [
      {
        id: "mock-session",
        source: "cli",
        workspace: "mock-workspace",
        state: "idle",
      },
    ]);

    const state = await requestJson(`${baseUrl}/api/sessions/mock-session/state`);
    assert.equal(state.response.status, 200);
    assert.equal(state.body.state.sessionId, "mock-session");
    assert.equal(state.body.state.status, "idle");
  });
});

test("sendPrompt records normalized user and assistant events", async () => {
  await withHost(async ({ baseUrl }) => {
    const sent = await requestJson(`${baseUrl}/api/sessions/mock-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "只回复 OK" }),
    });

    assert.equal(sent.response.status, 202);
    assert.match(sent.body.command.id, /^cmd_/);

    const events = await requestJson(`${baseUrl}/api/events?after=0`);
    assert.equal(events.response.status, 200);
    assert.deepEqual(
      events.body.events.map((event) => event.name),
      ["user.message", "session.state", "assistant.delta", "assistant.completed", "session.state"]
    );
    assert.equal(events.body.events[0].payload.text, "只回复 OK");
    assert.equal(events.body.events[2].payload.text, "OK");
  });
});

test("interrupts and resumes a session through normalized commands", async () => {
  await withHost(async ({ baseUrl }) => {
    const interrupted = await requestJson(
      `${baseUrl}/api/sessions/mock-session/interrupt`,
      { method: "POST", body: JSON.stringify({}) }
    );
    assert.equal(interrupted.response.status, 202);
    assert.equal(interrupted.body.state.status, "interrupted");
    assert.equal(interrupted.body.command.name, "interrupt");

    const resumed = await requestJson(`${baseUrl}/api/sessions/mock-session/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(resumed.response.status, 202);
    assert.equal(resumed.body.state.status, "idle");
    assert.equal(resumed.body.command.name, "resume");

    const events = await requestJson(`${baseUrl}/api/events?after=0`);
    assert.deepEqual(
      events.body.events.map((event) => event.payload.status),
      ["interrupted", "idle"]
    );
  });
});

test("rejects unauthenticated API calls", async () => {
  await withHost(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(response.status, 401);
  });
});

test("serves the mobile web console", async () => {
  await withHost(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /CodeBuddy Remote/);
    assert.match(html, /id="promptForm"/);
    assert.match(html, /id="terminalOutput"/);
    assert.match(html, /id="interruptButton"/);
    assert.match(html, /id="resumeButton"/);

    const terminalText = await fetch(`${baseUrl}/terminal-text.js`);
    const terminalTextSource = await terminalText.text();
    assert.equal(terminalText.status, 200);
    assert.match(terminalTextSource, /normalizeTerminalOutput/);
  });
});

test("streams adapter terminal output events", async () => {
  let emitAdapterEvent;
  const adapter = {
    listSessions() {
      return [{ id: "terminal-cli", source: "cli-terminal", workspace: "mock", state: "interactive" }];
    },
    getState() {
      return { sessionId: "terminal-cli", source: "cli-terminal", workspace: "mock", status: "interactive" };
    },
    onEvent(subscriber) {
      emitAdapterEvent = subscriber;
    },
    async sendPrompt() {
      return { conversationId: "terminal-cli", terminalOnly: true, assistantText: "", status: "interactive" };
    },
    async interrupt() {
      return this.getState();
    },
    async resume() {
      return this.getState();
    },
    async close() {},
  };
  const host = createLocalHost({ adapter, token: "test-token" });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    emitAdapterEvent({
      sessionId: "terminal-cli",
      conversationId: "terminal-cli",
      name: "terminal.output",
      payload: { text: "CodeBuddy ready" },
    });

    const events = await requestJson(`${baseUrl}/api/events?after=0`);
    assert.equal(events.response.status, 200);
    assert.equal(events.body.events[0].name, "terminal.output");
    assert.equal(events.body.events[0].payload.text, "CodeBuddy ready");
  } finally {
    await host.close();
  }
});

test("terminal-only prompts do not create empty assistant messages", async () => {
  const adapter = {
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
    async close() {},
  };
  const host = createLocalHost({ adapter, token: "test-token" });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const sent = await requestJson(`${baseUrl}/api/sessions/terminal-cli/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(sent.response.status, 202);

    const events = await requestJson(`${baseUrl}/api/events?after=0`);
    assert.deepEqual(
      events.body.events.map((event) => event.name),
      ["user.message", "session.state", "session.state"]
    );
    assert.equal(events.body.events[2].payload.status, "interactive");
  } finally {
    await host.close();
  }
});
