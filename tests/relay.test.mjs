import assert from "node:assert/strict";
import test from "node:test";

import { WebSocket } from "ws";

import { createLocalHost } from "../apps/local-host/src/local-host.mjs";
import { connectRelay } from "../apps/local-host/src/relay-client.mjs";
import { MockCliAdapter } from "../apps/local-host/src/mock-cli-adapter.mjs";
import { createRelayServer } from "../apps/relay/src/relay.mjs";
import { createCommand } from "../packages/protocol/src/index.mjs";

async function withRelay(testFn) {
  const relay = createRelayServer();
  const server = await relay.listen(0);
  const { port } = server.address();
  try {
    await testFn({ relay, relayUrl: `ws://127.0.0.1:${port}/relay` });
  } finally {
    await relay.close();
  }
}

async function withLocalHost(testFn) {
  const host = createLocalHost({
    adapter: new MockCliAdapter(),
    token: "test-token",
  });
  const server = await host.listen(0);
  try {
    await testFn({ host, server });
  } finally {
    await host.close();
  }
}

test("relay pairs a host and client, then forwards command responses", async () => {
  await withRelay(async ({ relayUrl }) => {
    await withLocalHost(async ({ host }) => {
      const relayClient = connectRelay({
        relayUrl,
        host,
        pairingCode: "TEST123",
        meta: { workspace: "mock-workspace" },
      });
      const phone = new WebSocket(relayUrl);

      try {
        await sleep(50);
        await waitForOpen(phone);
        phone.send(JSON.stringify({ type: "client.join", pairingCode: "TEST123" }));
        const joined = await readUntil(phone, (frame) => frame.type === "client.joined");
        assert.equal(joined.pairingCode, "TEST123");
        assert.equal(joined.meta.workspace, "mock-workspace");

        const command = createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        });
        phone.send(JSON.stringify({ type: "frame", payload: command }));

        const response = await readUntil(
          phone,
          (frame) => frame.type === "frame" && frame.payload?.type === "response"
        );
        assert.equal(response.payload.requestId, command.id);
        assert.equal(response.payload.ok, true);
        assert.equal(response.payload.body.sessions[0].id, "mock-session");
      } finally {
        phone.close();
        relayClient.close();
      }
    });
  });
});

test("relay rejects non CodeBuddyRemote protocol payloads", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({ type: "host.register", pairingCode: "SAFE1" }));
      await readUntil(host, (frame) => frame.type === "host.registered");

      await waitForOpen(phone);
      phone.send(JSON.stringify({ type: "client.join", pairingCode: "SAFE1" }));
      await readUntil(phone, (frame) => frame.type === "client.joined");

      phone.send(JSON.stringify({
        type: "frame",
        payload: { type: "tcp", port: 22, data: "nope" },
      }));
      const error = await readUntil(phone, (frame) => frame.type === "error");
      assert.match(error.error, /unsupported relay payload/);
    } finally {
      host.close();
      phone.close();
    }
  });
});

test("relay keeps joined clients attached when a host reconnects", async () => {
  await withRelay(async ({ relayUrl }) => {
    const oldHost = new WebSocket(relayUrl);
    const newHost = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);

    try {
      await waitForOpen(oldHost);
      oldHost.send(JSON.stringify({ type: "host.register", pairingCode: "SWAP1" }));
      await readUntil(oldHost, (frame) => frame.type === "host.registered");

      await waitForOpen(phone);
      phone.send(JSON.stringify({ type: "client.join", pairingCode: "SWAP1" }));
      await readUntil(phone, (frame) => frame.type === "client.joined");

      await waitForOpen(newHost);
      newHost.send(JSON.stringify({ type: "host.register", pairingCode: "SWAP1" }));
      await readUntil(newHost, (frame) => frame.type === "host.registered");

      const command = createCommand({
        sessionId: "local-host",
        name: "listSessions",
        payload: {},
      });
      phone.send(JSON.stringify({ type: "frame", payload: command }));

      const forwarded = await readUntil(
        newHost,
        (frame) => frame.type === "frame" && frame.payload?.id === command.id
      );
      assert.equal(forwarded.payload.name, "listSessions");

      newHost.send(JSON.stringify({
        type: "frame",
        payload: {
          type: "response",
          requestId: command.id,
          ok: true,
          body: { sessions: [] },
        },
      }));
      const response = await readUntil(
        phone,
        (frame) => frame.type === "frame" && frame.payload?.requestId === command.id
      );
      assert.equal(response.payload.ok, true);
    } finally {
      oldHost.close();
      newHost.close();
      phone.close();
    }
  });
});

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUntil(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket frame"));
    }, 1500);

    function onMessage(data) {
      const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      if (predicate(frame)) {
        cleanup();
        resolve(frame);
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function cleanup() {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    }

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}
