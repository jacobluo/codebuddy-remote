import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { WebSocket } from "ws";

import { MockCliAdapter } from "../apps/local-host/src/adapters/mock-cli-adapter.mjs";
import { createLocalHost } from "../apps/local-host/src/host/local-host.mjs";
import { connectRelay } from "../apps/local-host/src/relay/relay-client.mjs";
import { createRelayE2EPeer } from "../apps/local-host/src/relay/relay-e2e.mjs";
import { createRelayServer } from "../apps/relay/src/relay.mjs";
import { createCommand } from "../packages/protocol/src/index.mjs";

async function withRelay(testFn, options = {}) {
  const relay = createRelayServer(options);
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
        const { peer: phonePeer, joined } = await joinE2EPhone(phone, "TEST123");
        assert.equal(joined.pairingCode, "TEST123");
        assert.equal(joined.meta.workspace, "mock-workspace");

        const command = createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        });
        phone.send(JSON.stringify({ type: "frame", payload: phonePeer.encryptPayload(command) }));

        const encryptedResponse = await readUntil(
          phone,
          (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
        );
        assert.equal(JSON.stringify(encryptedResponse).includes("mock-session"), false);
        const response = phonePeer.decryptPayload(encryptedResponse.payload);
        assert.equal(response.requestId, command.id);
        assert.equal(response.ok, true);
        assert.equal(response.body.sessions[0].id, "mock-session");
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

test("relay rejects plaintext command payloads", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({ type: "host.register", pairingCode: "PLAIN1" }));
      await readUntil(host, (frame) => frame.type === "host.registered");

      await waitForOpen(phone);
      phone.send(JSON.stringify({ type: "client.join", pairingCode: "PLAIN1" }));
      await readUntil(phone, (frame) => frame.type === "client.joined");

      phone.send(JSON.stringify({
        type: "frame",
        payload: createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        }),
      }));
      const error = await readUntil(phone, (frame) => frame.type === "error");
      assert.match(error.error, /unsupported relay payload/);
    } finally {
      host.close();
      phone.close();
    }
  });
});

test("relay keeps server token on the host channel and uses pairing secret for clients", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);
    const intruder = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({
        type: "host.register",
        pairingCode: "TOKEN1",
        pairingSecret: "pair-secret-12345",
      }));
      const unauthorized = await readUntil(host, (frame) => frame.type === "error");
      assert.match(unauthorized.error, /unauthorized relay token/);

      const hostPeer = createRelayE2EPeer({ role: "host", pairingCode: "TOKEN1" });
      host.send(JSON.stringify({
        type: "host.register",
        pairingCode: "TOKEN1",
        pairingSecret: "pair-secret-12345",
        token: "relay-secret",
        e2e: {
          version: 1,
          publicKey: hostPeer.publicKey,
        },
      }));
      await readUntil(host, (frame) => frame.type === "host.registered");

      await waitForOpen(intruder);
      intruder.send(JSON.stringify({
        type: "client.join",
        pairingCode: "TOKEN1",
        pairingSecret: "wrong-secret-12345",
      }));
      const rejectedJoin = await readUntil(intruder, (frame) => frame.type === "error");
      assert.match(rejectedJoin.error, /pairing unavailable/);

      const { peer: phonePeer } = await joinE2EPhone(phone, "TOKEN1", {
        pairingSecret: "pair-secret-12345",
      });
      await acceptE2EClientOnHost(host, hostPeer);

      const command = createCommand({
        sessionId: "local-host",
        name: "listSessions",
        payload: {},
      });
      phone.send(JSON.stringify({ type: "frame", payload: phonePeer.encryptPayload(command) }));
      const forwarded = await readUntil(
        host,
        (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
      );
      assert.equal(JSON.stringify(forwarded).includes("listSessions"), false);
      const forwardedCommand = hostPeer.decryptPayload(forwarded.payload);
      assert.equal(forwardedCommand.id, command.id);
      assert.equal(forwardedCommand.name, "listSessions");
    } finally {
      host.close();
      phone.close();
      intruder.close();
    }
  }, { token: "relay-secret" });
});

test("relay expires pairing codes", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({ type: "host.register", pairingCode: "SHORT1" }));
      await readUntil(host, (frame) => frame.type === "host.registered");
      await sleep(40);

      await waitForOpen(phone);
      phone.send(JSON.stringify({ type: "client.join", pairingCode: "SHORT1" }));
      const error = await readUntil(phone, (frame) => frame.type === "error");
      assert.match(error.error, /pairing unavailable/);
    } finally {
      host.close();
      phone.close();
    }
  }, { pairingTtlMs: 20 });
});

test("relay does not allow a pairing code to add multiple clients", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const firstPhone = new WebSocket(relayUrl);
    const secondPhone = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({ type: "host.register", pairingCode: "ONCE1" }));
      await readUntil(host, (frame) => frame.type === "host.registered");

      await waitForOpen(firstPhone);
      firstPhone.send(JSON.stringify({ type: "client.join", pairingCode: "ONCE1" }));
      await readUntil(firstPhone, (frame) => frame.type === "client.joined");

      await waitForOpen(secondPhone);
      secondPhone.send(JSON.stringify({ type: "client.join", pairingCode: "ONCE1" }));
      const error = await readUntil(secondPhone, (frame) => frame.type === "error");
      assert.match(error.error, /pairing unavailable/);
    } finally {
      host.close();
      firstPhone.close();
      secondPhone.close();
    }
  });
});

test("relay keeps joined clients attached when a host reconnects", async () => {
  await withRelay(async ({ relayUrl }) => {
    const oldHost = new WebSocket(relayUrl);
    const newHost = new WebSocket(relayUrl);
    const phone = new WebSocket(relayUrl);
    const hostPeer = createRelayE2EPeer({ role: "host", pairingCode: "SWAP1" });

    try {
      await registerE2EHost(oldHost, "SWAP1", { peer: hostPeer });

      const { peer: phonePeer } = await joinE2EPhone(phone, "SWAP1");
      await acceptE2EClientOnHost(oldHost, hostPeer);

      await registerE2EHost(newHost, "SWAP1", { peer: hostPeer });

      const command = createCommand({
        sessionId: "local-host",
        name: "listSessions",
        payload: {},
      });
      phone.send(JSON.stringify({ type: "frame", payload: phonePeer.encryptPayload(command) }));

      const forwarded = await readUntil(
        newHost,
        (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
      );
      const forwardedCommand = hostPeer.decryptPayload(forwarded.payload);
      assert.equal(forwardedCommand.id, command.id);
      assert.equal(forwardedCommand.name, "listSessions");

      newHost.send(JSON.stringify({
        type: "frame",
        payload: hostPeer.encryptPayload({
          type: "response",
          requestId: command.id,
          ok: true,
          body: { sessions: [] },
        }),
      }));
      const response = await readUntil(
        phone,
        (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
      );
      assert.equal(phonePeer.decryptPayload(response.payload).ok, true);
    } finally {
      oldHost.close();
      newHost.close();
      phone.close();
    }
  });
});

test("relay client can backfill host events after joining", async () => {
  await withRelay(async ({ relayUrl }) => {
    await withLocalHost(async ({ host }) => {
      const relayClient = connectRelay({
        relayUrl,
        host,
        pairingCode: "BACKFILL1",
        meta: { workspace: "mock-workspace" },
      });
      const phone = new WebSocket(relayUrl);

      try {
        host.pushEvent({
          sessionId: "mock-session",
          conversationId: "mock-session",
          name: "terminal.output",
          payload: { text: "already rendered" },
        });

        await sleep(50);
        const { peer: phonePeer } = await joinE2EPhone(phone, "BACKFILL1");

        const command = createCommand({
          sessionId: "local-host",
          name: "listEvents",
          payload: { after: 0 },
        });
        phone.send(JSON.stringify({ type: "frame", payload: phonePeer.encryptPayload(command) }));

        const encryptedResponse = await readUntil(
          phone,
          (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
        );
        assert.equal(JSON.stringify(encryptedResponse).includes("already rendered"), false);
        const response = phonePeer.decryptPayload(encryptedResponse.payload);
        assert.equal(response.ok, true);
        assert.equal(response.body.latestSeq, 1);
        assert.equal(response.body.events[0].payload.text, "already rendered");
      } finally {
        phone.close();
        relayClient.close();
      }
    });
  });
});

test("relay e2e encrypts payloads without exposing plaintext to the relay", () => {
  const hostPeer = createRelayE2EPeer({ role: "host", pairingCode: "E2E1" });
  const clientPeer = createRelayE2EPeer({ role: "client", pairingCode: "E2E1" });
  hostPeer.deriveSession(clientPeer.publicKey);
  clientPeer.deriveSession(hostPeer.publicKey);

  const command = createCommand({
    sessionId: "local-host",
    name: "listSessions",
    payload: {},
  });
  const encrypted = clientPeer.encryptPayload(command);

  assert.equal(encrypted.type, "encrypted");
  assert.equal(JSON.stringify(encrypted).includes("listSessions"), false);
  assert.deepEqual(hostPeer.decryptPayload(encrypted), command);
});

test("relay forwards encrypted e2e command responses", async () => {
  await withRelay(async ({ relayUrl }) => {
    await withLocalHost(async ({ host }) => {
      const relayClient = connectRelay({
        relayUrl,
        host,
        pairingCode: "E2E123",
        meta: { workspace: "mock-workspace" },
      });
      const phone = new WebSocket(relayUrl);
      const phonePeer = createRelayE2EPeer({ role: "client", pairingCode: "E2E123" });

      try {
        await sleep(50);
        await waitForOpen(phone);
        phone.send(JSON.stringify({
          type: "client.join",
          pairingCode: "E2E123",
          e2e: {
            version: 1,
            publicKey: phonePeer.publicKey,
          },
        }));
        const joined = await readUntil(phone, (frame) => frame.type === "client.joined");
        assert.equal(joined.e2e.version, 1);
        phonePeer.deriveSession(joined.e2e.publicKey);

        const command = createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        });
        phone.send(JSON.stringify({
          type: "frame",
          payload: phonePeer.encryptPayload(command),
        }));

        const encryptedResponse = await readUntil(
          phone,
          (frame) => frame.type === "frame" && frame.payload?.type === "encrypted"
        );
        assert.equal(JSON.stringify(encryptedResponse).includes("mock-session"), false);

        const response = phonePeer.decryptPayload(encryptedResponse.payload);
        assert.equal(response.type, "response");
        assert.equal(response.requestId, command.id);
        assert.equal(response.ok, true);
        assert.equal(response.body.sessions[0].id, "mock-session");
      } finally {
        phone.close();
        relayClient.close();
      }
    });
  });
});

test("relay lets a registered device rejoin with HMAC after pairing expires", async () => {
  await withRelay(async ({ relayUrl }) => {
    const host = new WebSocket(relayUrl);
    const firstPhone = new WebSocket(relayUrl);
    const returningPhone = new WebSocket(relayUrl);

    try {
      await waitForOpen(host);
      host.send(JSON.stringify({
        type: "host.register",
        pairingCode: "DEVICE1",
        pairingSecret: "pair-secret-12345",
      }));
      await readUntil(host, (frame) => frame.type === "host.registered");

      await waitForOpen(firstPhone);
      firstPhone.send(JSON.stringify({
        type: "client.join",
        pairingCode: "DEVICE1",
        pairingSecret: "pair-secret-12345",
        deviceId: "relay-device-1",
        deviceSecret: "relay-device-secret-1",
        deviceName: "iPhone",
      }));
      await readUntil(firstPhone, (frame) => frame.type === "client.joined");
      firstPhone.close();
      await sleep(20);
      await sleep(30);

      await waitForOpen(returningPhone);
      const timestamp = String(Date.now());
      const nonce = "relay-nonce-1";
      returningPhone.send(JSON.stringify({
        type: "client.join",
        pairingCode: "DEVICE1",
        deviceId: "relay-device-1",
        timestamp,
        nonce,
        signature: signRelayDeviceRequest({
          secret: "relay-device-secret-1",
          pairingCode: "DEVICE1",
          timestamp,
          nonce,
        }),
      }));
      const joined = await readUntil(returningPhone, (frame) => frame.type === "client.joined");
      assert.equal(joined.clientId.startsWith("client_"), true);

      const replay = new WebSocket(relayUrl);
      await waitForOpen(replay);
      replay.send(JSON.stringify({
        type: "client.join",
        pairingCode: "DEVICE1",
        deviceId: "relay-device-1",
        timestamp,
        nonce,
        signature: signRelayDeviceRequest({
          secret: "relay-device-secret-1",
          pairingCode: "DEVICE1",
          timestamp,
          nonce,
        }),
      }));
      const replayError = await readUntil(replay, (frame) => frame.type === "error");
      assert.match(replayError.error, /pairing unavailable/);
      replay.close();
    } finally {
      host.close();
      firstPhone.close();
      returningPhone.close();
    }
  }, { pairingTtlMs: 20 });
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

async function registerE2EHost(ws, pairingCode, {
  pairingSecret,
  token,
  peer = createRelayE2EPeer({ role: "host", pairingCode }),
} = {}) {
  await waitForOpen(ws);
  ws.send(JSON.stringify({
    type: "host.register",
    pairingCode,
    pairingSecret,
    token,
    e2e: {
      version: 1,
      publicKey: peer.publicKey,
    },
  }));
  const registered = await readUntil(ws, (frame) => frame.type === "host.registered");
  return { peer, registered };
}

async function joinE2EPhone(ws, pairingCode, {
  pairingSecret,
  peer = createRelayE2EPeer({ role: "client", pairingCode }),
} = {}) {
  await waitForOpen(ws);
  ws.send(JSON.stringify({
    type: "client.join",
    pairingCode,
    pairingSecret,
    e2e: {
      version: 1,
      publicKey: peer.publicKey,
    },
  }));
  const joined = await readUntil(ws, (frame) => frame.type === "client.joined");
  assert.equal(joined.e2e.version, 1);
  peer.deriveSession(joined.e2e.publicKey);
  return { peer, joined };
}

async function acceptE2EClientOnHost(ws, peer) {
  const joined = await readUntil(ws, (frame) => frame.type === "client.joined");
  assert.equal(joined.e2e.version, 1);
  peer.deriveSession(joined.e2e.publicKey);
  return joined;
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

function signRelayDeviceRequest({ secret, pairingCode, timestamp, nonce }) {
  return createHmac("sha256", secret)
    .update(["relay.join", pairingCode, timestamp, nonce].join("\n"))
    .digest("base64url");
}
