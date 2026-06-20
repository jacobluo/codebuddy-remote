import { WebSocket } from "ws";

import { createRelayE2EPeer, isRelayEncryptedPayload } from "./relay-e2e.mjs";

export function connectRelay({
  relayUrl,
  host,
  pairingCode,
  pairingSecret = "",
  relayToken = "",
  meta = {},
}) {
  if (!relayUrl) return null;

  let ws;
  let unsubscribe;
  let closed = false;
  let loggedConnected = false;
  const e2ePeer = createRelayE2EPeer({ role: "host", pairingCode });

  function connect() {
    ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      const registerFrame = {
        type: "host.register",
        pairingCode,
        pairingSecret,
        token: relayToken,
        meta,
      };
      registerFrame.e2e = {
        version: e2ePeer.version,
        publicKey: e2ePeer.publicKey,
      };
      send(registerFrame);
      unsubscribe = host.subscribe((event) => {
        sendRelayPayload(event);
      });
    });

    ws.on("message", (data) => {
      void handleMessage(data).catch((error) => {
        console.error(`[codebuddy-remote] relay message error: ${error.message}`);
      });
    });

    ws.on("close", () => {
      unsubscribe?.();
      unsubscribe = null;
      if (!closed) setTimeout(connect, 1500);
    });

    ws.on("error", (error) => {
      console.error(`[codebuddy-remote] relay error: ${error.message}`);
    });
  }

  async function handleMessage(data) {
    const frame = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));

    if (frame.type === "host.registered") {
      if (!loggedConnected) {
        console.log(`[codebuddy-remote] relay connected: ${relayUrl}`);
        console.log(`[codebuddy-remote] pairing code: ${frame.pairingCode}`);
        loggedConnected = true;
      }
      return;
    }

    if (frame.type === "client.joined") {
      console.log(`[codebuddy-remote] relay client joined: ${frame.clientId}`);
      if (frame.e2e?.publicKey) {
        e2ePeer.deriveSession(frame.e2e.publicKey);
        console.log("[codebuddy-remote] relay e2e session established");
      }
      return;
    }

    if (frame.type !== "frame") return;

    const payload = decodeRelayPayload(frame.payload);
    if (payload?.type !== "command") return;

    try {
      console.log(
        `[codebuddy-remote] relay command: ${payload.name} ${payload.id}`
      );
      const body = await host.handleCommand(payload);
      console.log(
        `[codebuddy-remote] relay response: ${payload.name} ${payload.id}`
      );
      sendRelayPayload({
        type: "response",
        requestId: payload.id,
        ok: true,
        body,
      });
    } catch (error) {
      sendRelayPayload({
        type: "response",
        requestId: payload.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function decodeRelayPayload(payload) {
    if (!isRelayEncryptedPayload(payload)) return null;
    return e2ePeer.decryptPayload(payload);
  }

  function sendRelayPayload(payload) {
    try {
      send({ type: "frame", payload: e2ePeer.encryptPayload(payload) });
    } catch {
      return;
    }
  }

  function send(frame) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  connect();

  return {
    close() {
      closed = true;
      unsubscribe?.();
      ws?.close();
    },
  };
}
