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

const DEFAULT_PAIRING_TTL_MS = 120000;
const DEFAULT_MAX_FRAME_BYTES = 128 * 1024;
const DEFAULT_JOIN_FAILURE_LIMIT = 8;
const DEFAULT_JOIN_FAILURE_WINDOW_MS = 60000;

export function createRelayServer({
  token = "",
  pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  joinFailureLimit = DEFAULT_JOIN_FAILURE_LIMIT,
  joinFailureWindowMs = DEFAULT_JOIN_FAILURE_WINDOW_MS,
} = {}) {
  const hostsByPairingCode = new Map();
  const clientsBySocket = new Map();
  const joinFailuresByPeer = new Map();
  const stats = {
    framesFromHosts: 0,
    framesFromClients: 0,
    commandsFromClients: 0,
    rejectedJoins: 0,
  };
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
        if (frameSize(data) > maxFrameBytes) {
          throw new Error("relay frame is too large");
        }
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
        stats: { ...stats },
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

    if (token && !isAuthorizedToken(frame.token, token)) {
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
    const clients = previous?.clients ?? new Set();
    const now = Date.now();

    const host = {
      ws,
      hostId: frame.hostId || `host_${crypto.randomUUID()}`,
      pairingCode,
      meta: frame.meta || {},
      clients,
      paired: Boolean(previous?.paired),
      expiresAt: previous?.paired ? previous.expiresAt : now + pairingTtlMs,
    };
    hostsByPairingCode.set(pairingCode, host);
    for (const clientWs of clients) {
      const client = clientsBySocket.get(clientWs);
      if (client) client.host = host;
    }
    ws.role = "host";
    ws.pairingCode = pairingCode;
    send(ws, {
      type: "host.registered",
      hostId: host.hostId,
      pairingCode,
      expiresAt: host.expiresAt,
      meta: host.meta,
    });
    if (previous && previous.ws !== ws) {
      closeQuietly(previous.ws, 4001, "host replaced");
    }
  }

  function joinClient(ws, frame) {
    assertJoinAllowed(ws);
    const pairingCode = normalizePairingCode(frame.pairingCode);
    const host = hostsByPairingCode.get(pairingCode);
    if (!host || host.ws.readyState !== host.ws.OPEN || Date.now() > host.expiresAt) {
      recordJoinFailure(ws);
      throw new Error("pairing unavailable");
    }
    if (host.paired && host.clients.size > 0) {
      recordJoinFailure(ws);
      throw new Error("pairing unavailable");
    }

    const client = {
      ws,
      clientId: frame.clientId || `client_${crypto.randomUUID()}`,
      pairingCode,
      host,
    };
    clientsBySocket.set(ws, client);
    host.clients.add(ws);
    host.paired = true;
    ws.role = "client";
    ws.pairingCode = pairingCode;
    send(ws, {
      type: "client.joined",
      clientId: client.clientId,
      hostId: host.hostId,
      pairingCode,
      pairingExpiresAt: host.expiresAt,
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
      stats.framesFromHosts += 1;
      for (const clientWs of host.clients) {
        send(clientWs, { type: "frame", payload: frame.payload });
      }
      return;
    }

    if (ws.role === "client") {
      const client = clientsBySocket.get(ws);
      if (!client) throw new Error("client is not joined");
      stats.framesFromClients += 1;
      if (frame.payload.type === "command") {
        stats.commandsFromClients += 1;
        console.log(
          `[codebuddy-relay] command ${frame.payload.name} ${frame.payload.id} from ${client.clientId}`
        );
      }
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

  function assertJoinAllowed(ws) {
    const peer = getPeerKey(ws);
    const item = joinFailuresByPeer.get(peer);
    if (!item || Date.now() > item.resetAt) return;
    if (item.count >= joinFailureLimit) {
      throw new Error("too many pairing attempts");
    }
  }

  function recordJoinFailure(ws) {
    stats.rejectedJoins += 1;
    const peer = getPeerKey(ws);
    const now = Date.now();
    const item = joinFailuresByPeer.get(peer);
    if (!item || now > item.resetAt) {
      joinFailuresByPeer.set(peer, {
        count: 1,
        resetAt: now + joinFailureWindowMs,
      });
      return;
    }
    item.count += 1;
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

function frameSize(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  return Buffer.byteLength(String(data), "utf8");
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

function isAuthorizedToken(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function getPeerKey(ws) {
  return ws._socket?.remoteAddress || "unknown";
}
