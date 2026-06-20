import crypto from "node:crypto";
import http from "node:http";

import { WebSocket, WebSocketServer } from "ws";
import {
  validateCommand,
  validateEvent,
} from "../../../packages/protocol/src/index.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function createRelayServer({ token } = {}) {
  const hostsByPairingCode = new Map();
  const clientsBySocket = new Map();
  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/relay") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        handleFrame(ws, parseJson(data));
      } catch (error) {
        send(ws, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    ws.on("close", () => removeSocket(ws));
    ws.on("error", () => removeSocket(ws));
  });

  function handleHttp(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        hosts: hostsByPairingCode.size,
        clients: clientsBySocket.size,
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  }

  function handleFrame(ws, frame) {
    assertObject(frame, "frame");

    if (frame.type === "ping") {
      send(ws, { type: "pong", ts: Date.now() });
      return;
    }

    if (token && frame.token !== token) {
      throw new Error("unauthorized relay token");
    }

    if (frame.type === "host.register") {
      registerHost(ws, frame);
      return;
    }

    if (frame.type === "client.join") {
      joinClient(ws, frame);
      return;
    }

    if (frame.type === "frame") {
      forwardFrame(ws, frame);
      return;
    }

    throw new Error(`unknown relay frame: ${frame.type}`);
  }

  function registerHost(ws, frame) {
    const pairingCode = normalizePairingCode(frame.pairingCode || createPairingCode());
    const previous = hostsByPairingCode.get(pairingCode);
    if (previous && previous.ws !== ws) {
      closeQuietly(previous.ws, 4001, "host replaced");
    }

    const host = {
      ws,
      hostId: frame.hostId || `host_${crypto.randomUUID()}`,
      pairingCode,
      meta: frame.meta || {},
      clients: new Set(),
    };
    hostsByPairingCode.set(pairingCode, host);
    ws.role = "host";
    ws.pairingCode = pairingCode;
    send(ws, {
      type: "host.registered",
      hostId: host.hostId,
      pairingCode,
      meta: host.meta,
    });
  }

  function joinClient(ws, frame) {
    const pairingCode = normalizePairingCode(frame.pairingCode);
    const host = hostsByPairingCode.get(pairingCode);
    if (!host || host.ws.readyState !== host.ws.OPEN) {
      throw new Error("host is offline or pairing code is invalid");
    }

    const client = {
      ws,
      clientId: frame.clientId || `client_${crypto.randomUUID()}`,
      pairingCode,
      host,
    };
    clientsBySocket.set(ws, client);
    host.clients.add(ws);
    ws.role = "client";
    ws.pairingCode = pairingCode;
    send(ws, {
      type: "client.joined",
      clientId: client.clientId,
      hostId: host.hostId,
      pairingCode,
      meta: host.meta,
    });
    send(host.ws, {
      type: "client.joined",
      clientId: client.clientId,
      pairingCode,
    });
  }

  function forwardFrame(ws, frame) {
    validateRelayPayload(frame.payload);
    if (ws.role === "host") {
      const host = hostsByPairingCode.get(ws.pairingCode);
      if (!host) throw new Error("host is not registered");
      for (const clientWs of host.clients) {
        send(clientWs, { type: "frame", payload: frame.payload });
      }
      return;
    }

    if (ws.role === "client") {
      const client = clientsBySocket.get(ws);
      if (!client) throw new Error("client is not joined");
      send(client.host.ws, { type: "frame", payload: frame.payload });
      return;
    }

    throw new Error("socket must register or join before forwarding frames");
  }

  function removeSocket(ws) {
    if (ws.role === "host") {
      const host = hostsByPairingCode.get(ws.pairingCode);
      if (host?.ws === ws) {
        hostsByPairingCode.delete(ws.pairingCode);
        for (const clientWs of host.clients) {
          send(clientWs, { type: "host.left", pairingCode: ws.pairingCode });
        }
      }
      return;
    }

    if (ws.role === "client") {
      const client = clientsBySocket.get(ws);
      clientsBySocket.delete(ws);
      client?.host.clients.delete(ws);
      if (client?.host.ws.readyState === client.host.ws.OPEN) {
        send(client.host.ws, {
          type: "client.left",
          clientId: client.clientId,
          pairingCode: client.pairingCode,
        });
      }
    }
  }

  return {
    listen(port = 17330, host = "127.0.0.1") {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        for (const socket of wss.clients) closeQuietly(socket);
        wss.close(() => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
    },
    server,
  };
}

function validateRelayPayload(payload) {
  assertObject(payload, "frame.payload");
  if (payload.type === "command") {
    validateCommand(payload);
    return;
  }
  if (payload.type === "event") {
    validateEvent(payload);
    return;
  }
  if (payload.type === "response") {
    if (!payload.requestId) throw new Error("response.requestId is required");
    return;
  }
  throw new Error(`unsupported relay payload: ${payload.type}`);
}

function parseJson(data) {
  return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
}

function send(ws, frame) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function closeQuietly(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {}
}

function normalizePairingCode(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,64}$/.test(code)) {
    throw new Error("pairingCode must be 4-64 letters, digits, _ or -");
  }
  return code;
}

function createPairingCode() {
  return crypto.randomBytes(5).toString("base64url").toUpperCase();
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}
