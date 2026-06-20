import { WebSocket } from "ws";

export function connectRelay({
  relayUrl,
  host,
  pairingCode,
  relayToken = "",
  meta = {},
}) {
  if (!relayUrl) return null;

  let ws;
  let unsubscribe;
  let closed = false;

  function connect() {
    ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      send({
        type: "host.register",
        pairingCode,
        token: relayToken,
        meta,
      });
      unsubscribe = host.subscribe((event) => {
        send({ type: "frame", payload: event, token: relayToken });
      });
    });

    ws.on("message", (data) => {
      void handleMessage(data);
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
      console.log(`[codebuddy-remote] relay connected: ${relayUrl}`);
      console.log(`[codebuddy-remote] pairing code: ${frame.pairingCode}`);
      return;
    }

    if (frame.type === "client.joined") {
      console.log(`[codebuddy-remote] relay client joined: ${frame.clientId}`);
      for (const event of host.getEvents({ after: 0 })) {
        send({ type: "frame", payload: event, token: relayToken });
      }
      return;
    }

    if (frame.type !== "frame" || frame.payload?.type !== "command") return;

    try {
      const body = await host.handleCommand(frame.payload);
      send({
        type: "frame",
        token: relayToken,
        payload: {
          type: "response",
          requestId: frame.payload.id,
          ok: true,
          body,
        },
      });
    } catch (error) {
      send({
        type: "frame",
        token: relayToken,
        payload: {
          type: "response",
          requestId: frame.payload.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
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
