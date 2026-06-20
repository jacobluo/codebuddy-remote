import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("does not serve a mobile web console", async () => {
  await withHost(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { ok: false, error: "unauthorized" });
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

test("event history can be windowed without losing latest sequence", async () => {
  await withHost(async ({ baseUrl, host }) => {
    for (let index = 1; index <= 5; index += 1) {
      host.pushEvent({
        sessionId: "mock-session",
        name: "assistant.delta",
        payload: { text: `message-${index}` },
      });
    }

    const httpEvents = await requestJson(`${baseUrl}/api/events?after=0&limit=2`);
    assert.equal(httpEvents.response.status, 200);
    assert.equal(httpEvents.body.latestSeq, 5);
    assert.deepEqual(
      httpEvents.body.events.map((event) => event.payload.text),
      ["message-4", "message-5"]
    );

    const commandEvents = await host.handleCommand({
      type: "command",
      id: "cmd_windowed_events",
      sessionId: "local-host",
      name: "listEvents",
      payload: { before: 5, limit: 2 },
    });
    assert.equal(commandEvents.latestSeq, 5);
    assert.deepEqual(
      commandEvents.events.map((event) => event.payload.text),
      ["message-3", "message-4"]
    );
  });
});

test("event history survives a local host restart", async () => {
  const historyDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-history-"));
  const historyFile = join(historyDir, "events.jsonl");

  try {
    {
      const adapter = new MockCliAdapter();
      const host = createLocalHost({
        adapter,
        token: "test-token",
        historyFile,
      });
      await host.listen(0);

      host.pushEvent({
        sessionId: "mock-session",
        conversationId: "mock-conversation",
        name: "assistant.delta",
        payload: { text: "persisted reply" },
      });

      await host.close();
    }

    const adapter = new MockCliAdapter();
    const host = createLocalHost({
      adapter,
      token: "test-token",
      historyFile,
    });
    const server = await host.listen(0);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const events = await requestJson(`${baseUrl}/api/events?after=0`);
      assert.equal(events.response.status, 200);
      assert.equal(events.body.latestSeq, 1);
      assert.deepEqual(
        events.body.events.map((event) => event.payload.text),
        ["persisted reply"]
      );
    } finally {
      await host.close();
    }
  } finally {
    await rm(historyDir, { recursive: true, force: true });
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

test("terminal input sends raw controls without recording a user message", async () => {
  let rawInput = "";
  const adapter = {
    listSessions() {
      return [{ id: "terminal-cli", source: "cli-terminal", workspace: "mock", state: "interactive" }];
    },
    getState() {
      return { sessionId: "terminal-cli", source: "cli-terminal", workspace: "mock", status: "interactive" };
    },
    onEvent() {},
    async sendPrompt() {
      throw new Error("sendPrompt should not be used for raw terminal input");
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
    async close() {},
  };
  const host = createLocalHost({ adapter, token: "test-token" });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const sent = await requestJson(`${baseUrl}/api/sessions/terminal-cli/input`, {
      method: "POST",
      body: JSON.stringify({ text: "1", label: "允许一次" }),
    });
    assert.equal(sent.response.status, 202);
    assert.equal(sent.body.command.name, "sendTerminalInput");
    assert.equal(rawInput, "1");

    const events = await requestJson(`${baseUrl}/api/events?after=0`);
    assert.deepEqual(
      events.body.events.map((event) => event.name),
      ["tool.permissionResolved", "session.state"]
    );
    assert.equal(events.body.events[0].payload.title, "允许一次");
  } finally {
    await host.close();
  }
});

test("terminal input rejects arbitrary text", async () => {
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
    async sendTerminalInput() {
      throw new Error("sendTerminalInput should reject before reaching adapter");
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
    const sent = await requestJson(`${baseUrl}/api/sessions/terminal-cli/input`, {
      method: "POST",
      body: JSON.stringify({ text: "rm -rf", label: "bad" }),
    });
    assert.equal(sent.response.status, 500);
    assert.match(sent.body.error, /single approved control key/);
  } finally {
    await host.close();
  }
});

test("binds a device and accepts signed local API requests", async () => {
  const deviceDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-devices-"));
  const deviceStoreFile = join(deviceDir, "devices.json");
  const adapter = new MockCliAdapter();
  const host = createLocalHost({
    adapter,
    token: "test-token",
    deviceStoreFile,
  });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deviceId = "device-1";
  const deviceSecret = "secret-1";

  try {
    const bound = await requestJson(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        deviceSecret,
        deviceName: "iPhone",
      }),
    });

    assert.equal(bound.response.status, 200);
    assert.equal(bound.body.ok, true);
    assert.equal(bound.body.device.deviceId, deviceId);

    const body = "";
    const timestamp = String(Date.now());
    const nonce = "nonce-1";
    const path = "/api/sessions";
    const signature = signDeviceRequest({
      secret: deviceSecret,
      method: "GET",
      path,
      body,
      timestamp,
      nonce,
    });
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-codebuddy-device-id": deviceId,
        "x-codebuddy-timestamp": timestamp,
        "x-codebuddy-nonce": nonce,
        "x-codebuddy-signature": signature,
      },
    });
    const sessions = await response.json();

    assert.equal(response.status, 200);
    assert.equal(sessions.sessions[0].id, "mock-session");

    const promptBody = JSON.stringify({ text: "只回复 OK" });
    const promptPath = "/api/sessions/mock-session/messages";
    const promptTimestamp = String(Date.now());
    const promptNonce = "nonce-2";
    const promptSignature = signDeviceRequest({
      secret: deviceSecret,
      method: "POST",
      path: promptPath,
      body: promptBody,
      timestamp: promptTimestamp,
      nonce: promptNonce,
    });
    const promptResponse = await fetch(`${baseUrl}${promptPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codebuddy-device-id": deviceId,
        "x-codebuddy-timestamp": promptTimestamp,
        "x-codebuddy-nonce": promptNonce,
        "x-codebuddy-signature": promptSignature,
      },
      body: promptBody,
    });
    const promptResult = await promptResponse.json();

    assert.equal(promptResponse.status, 202);
    assert.equal(promptResult.command.name, "sendPrompt");
  } finally {
    await host.close();
    await rm(deviceDir, { recursive: true, force: true });
  }
});

test("rejects replayed signed requests with the same device nonce", async () => {
  const deviceDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-replay-"));
  const deviceStoreFile = join(deviceDir, "devices.json");
  const adapter = new MockCliAdapter();
  const host = createLocalHost({
    adapter,
    token: "test-token",
    deviceStoreFile,
  });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deviceId = "device-replay";
  const deviceSecret = "secret-replay";

  try {
    await requestJson(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      body: JSON.stringify({ deviceId, deviceSecret, deviceName: "iPhone" }),
    });

    const timestamp = String(Date.now());
    const nonce = "nonce-reused";
    const path = "/api/sessions";
    const signature = signDeviceRequest({
      secret: deviceSecret,
      method: "GET",
      path,
      body: "",
      timestamp,
      nonce,
    });
    const headers = {
      "x-codebuddy-device-id": deviceId,
      "x-codebuddy-timestamp": timestamp,
      "x-codebuddy-nonce": nonce,
      "x-codebuddy-signature": signature,
    };

    const first = await fetch(`${baseUrl}${path}`, { headers });
    const second = await fetch(`${baseUrl}${path}`, { headers });

    assert.equal(first.status, 200);
    assert.equal(second.status, 401);
  } finally {
    await host.close();
    await rm(deviceDir, { recursive: true, force: true });
  }
});

test("lists and revokes bound devices through admin token", async () => {
  const deviceDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-device-admin-"));
  const deviceStoreFile = join(deviceDir, "devices.json");
  const adapter = new MockCliAdapter();
  const host = createLocalHost({
    adapter,
    token: "test-token",
    deviceStoreFile,
  });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await requestJson(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-admin",
        deviceSecret: "secret-admin",
        deviceName: "iPhone",
      }),
    });

    const listed = await requestJson(`${baseUrl}/api/devices`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(Object.keys(listed.body.devices[0]).sort(), [
      "createdAt",
      "deviceId",
      "deviceName",
      "lastSeenAt",
      "revoked",
    ]);
    assert.equal(listed.body.devices[0].deviceId, "device-admin");
    assert.equal(listed.body.devices[0].deviceSecret, undefined);

    const revoked = await requestJson(`${baseUrl}/api/devices/device-admin/revoke`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body.device.revoked, true);

    const timestamp = String(Date.now());
    const nonce = "nonce-after-revoke";
    const path = "/api/sessions";
    const signature = signDeviceRequest({
      secret: "secret-admin",
      method: "GET",
      path,
      body: "",
      timestamp,
      nonce,
    });
    const signed = await fetch(`${baseUrl}${path}`, {
      headers: {
        "x-codebuddy-device-id": "device-admin",
        "x-codebuddy-timestamp": timestamp,
        "x-codebuddy-nonce": nonce,
        "x-codebuddy-signature": signature,
      },
    });
    assert.equal(signed.status, 401);
  } finally {
    await host.close();
    await rm(deviceDir, { recursive: true, force: true });
  }
});

test("writes local security audit records", async () => {
  const auditDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-audit-"));
  const auditFile = join(auditDir, "audit.jsonl");
  const adapter = new MockCliAdapter();
  const host = createLocalHost({
    adapter,
    token: "test-token",
    auditFile,
  });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await requestJson(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-audit",
        deviceSecret: "secret-audit",
        deviceName: "iPhone",
      }),
    });
    await requestJson(`${baseUrl}/api/sessions/mock-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "请检查项目状态" }),
    });
    await requestJson(`${baseUrl}/api/sessions/mock-session/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const lines = (await readFile(auditFile, "utf8")).trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["device.bound", "prompt.sent", "session.interrupt"]
    );
    assert.equal(entries[1].promptLength, "请检查项目状态".length);
    assert.equal(entries[1].promptSha256.length, 64);
    assert.equal(entries[1].promptText, undefined);
  } finally {
    await host.close();
    await rm(auditDir, { recursive: true, force: true });
  }
});

test("consumes one-time bind tokens after device binding", async () => {
  const deviceDir = await mkdtemp(join(tmpdir(), "codebuddy-remote-bind-token-"));
  const deviceStoreFile = join(deviceDir, "devices.json");
  const adapter = new MockCliAdapter();
  const host = createLocalHost({
    adapter,
    token: "test-token",
    bindToken: "bind-once",
    deviceStoreFile,
  });
  const server = await host.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const first = await fetch(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      headers: {
        authorization: "Bearer bind-once",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: "device-one",
        deviceSecret: "secret-one",
        deviceName: "iPhone",
      }),
    });
    const second = await fetch(`${baseUrl}/api/devices/bind`, {
      method: "POST",
      headers: {
        authorization: "Bearer bind-once",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId: "device-two",
        deviceSecret: "secret-two",
        deviceName: "iPad",
      }),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 401);
  } finally {
    await host.close();
    await rm(deviceDir, { recursive: true, force: true });
  }
});

function signDeviceRequest({ secret, method, path, body, timestamp, nonce }) {
  return crypto
    .createHmac("sha256", secret)
    .update([method, path, body, timestamp, nonce].join("\n"))
    .digest("base64url");
}
