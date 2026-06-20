import crypto from "node:crypto";
import http from "node:http";

import { WebSocket, WebSocketServer } from "ws";
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const DEFAULT_PAIRING_TTL_MS = 120000;
const DEFAULT_MAX_FRAME_BYTES = 128 * 1024;
const DEFAULT_JOIN_FAILURE_LIMIT = 8;
const DEFAULT_JOIN_FAILURE_WINDOW_MS = 60000;
const MAX_DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

    if (frame.type === "host.register") {
      if (token && !isAuthorizedToken(frame.token, token)) {
        throw new Error("unauthorized relay token");
      }
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
    const pairingSecret = normalizeOptionalPairingSecret(frame.pairingSecret);
    if (token && !pairingSecret) {
      throw new Error("pairingSecret is required when relay token is configured");
    }
    const previous = hostsByPairingCode.get(pairingCode);
    const clients = previous?.clients ?? new Set();
    const devices = previous?.devices ?? new Map();
    const usedDeviceNonces = previous?.usedDeviceNonces ?? new Map();
    const now = Date.now();

    const host = {
      ws,
      hostId: frame.hostId || `host_${crypto.randomUUID()}`,
      pairingCode,
      pairingSecretHash: pairingSecret ? hashPairingSecret(pairingSecret) : "",
      e2e: sanitizeRelayE2E(frame.e2e),
      devices,
      usedDeviceNonces,
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
    if (!host || host.ws.readyState !== host.ws.OPEN) {
      recordJoinFailure(ws);
      throw new Error("pairing unavailable");
    }

    const pairingAuthorized =
      Date.now() <= host.expiresAt &&
      (!host.pairingSecretHash ||
        isAuthorizedPairingSecret(frame.pairingSecret, host.pairingSecretHash));
    const deviceAuthorized = verifyRelayDeviceJoin(host, frame);

    if (!pairingAuthorized && !deviceAuthorized) {
      recordJoinFailure(ws);
      throw new Error("pairing unavailable");
    }
    if (host.paired && host.clients.size > 0) {
      recordJoinFailure(ws);
      throw new Error("pairing unavailable");
    }

    if (pairingAuthorized && frame.deviceId && frame.deviceSecret) {
      registerRelayDevice(host, {
        deviceId: frame.deviceId,
        deviceSecret: frame.deviceSecret,
        deviceName: frame.deviceName,
      });
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
      e2e: host.e2e,
    });
    send(host.ws, {
      type: "client.joined",
      clientId: client.clientId,
      pairingCode,
      e2e: sanitizeRelayE2E(frame.e2e),
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
  if (payload.type === "encrypted") {
    validateEncryptedPayload(payload);
    return;
  }
  throw new Error(`unsupported relay payload: ${payload.type}`);
}

function validateEncryptedPayload(payload) {
  if (payload.version !== 1) throw new Error("encrypted.version must be 1");
  if (payload.alg !== "P256-HKDF-SHA256-CHACHA20-POLY1305") {
    throw new Error("encrypted.alg is unsupported");
  }
  if (!Number.isSafeInteger(payload.seq) || payload.seq < 1) {
    throw new Error("encrypted.seq is required");
  }
  if (typeof payload.nonce !== "string" || !payload.nonce) {
    throw new Error("encrypted.nonce is required");
  }
  if (typeof payload.ciphertext !== "string" || !payload.ciphertext) {
    throw new Error("encrypted.ciphertext is required");
  }
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

function sanitizeRelayE2E(value) {
  if (value === undefined || value === null) return undefined;
  assertObject(value, "e2e");
  if (value.version !== 1) throw new Error("e2e.version must be 1");
  const publicKey = String(value.publicKey || "").trim();
  if (!/^[a-zA-Z0-9_-]{80,128}$/.test(publicKey)) {
    throw new Error("e2e.publicKey is invalid");
  }
  return {
    version: 1,
    alg: "P256-HKDF-SHA256-CHACHA20-POLY1305",
    publicKey,
  };
}

function isAuthorizedToken(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function normalizeOptionalPairingSecret(value) {
  if (value === undefined || value === null || value === "") return "";
  const secret = String(value).trim();
  if (!/^[a-zA-Z0-9_-]{16,256}$/.test(secret)) {
    throw new Error("pairingSecret must be 16-256 URL-safe characters");
  }
  return secret;
}

function hashPairingSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("base64url");
}

function isAuthorizedPairingSecret(provided, expectedHash) {
  const secret = normalizeOptionalPairingSecret(provided);
  if (!secret) return false;
  return isAuthorizedToken(hashPairingSecret(secret), expectedHash);
}

function registerRelayDevice(host, { deviceId, deviceSecret, deviceName }) {
  const id = String(deviceId || "").trim();
  const secret = String(deviceSecret || "").trim();
  if (!id || !secret) return;
  host.devices.set(id, {
    deviceId: id,
    deviceSecret: secret,
    deviceName: String(deviceName || "CodeBuddy Remote"),
    createdAt: new Date().toISOString(),
  });
}

function verifyRelayDeviceJoin(host, frame) {
  const deviceId = String(frame.deviceId || "").trim();
  const timestamp = String(frame.timestamp || "").trim();
  const nonce = String(frame.nonce || "").trim();
  const signature = String(frame.signature || "").trim();
  if (!deviceId || !timestamp || !nonce || !signature) return false;

  const device = host.devices.get(deviceId);
  if (!device) return false;

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime)) return false;
  if (Math.abs(Date.now() - requestTime) > MAX_DEVICE_CLOCK_SKEW_MS) return false;

  pruneRelayDeviceNonces(host.usedDeviceNonces);
  const nonceKey = `${deviceId}:${nonce}`;
  if (host.usedDeviceNonces.has(nonceKey)) return false;

  const expected = signRelayDeviceRequest({
    secret: device.deviceSecret,
    pairingCode: host.pairingCode,
    timestamp,
    nonce,
  });
  if (!timingSafeStringEqual(signature, expected)) return false;
  host.usedDeviceNonces.set(nonceKey, Date.now() + MAX_DEVICE_CLOCK_SKEW_MS);
  return true;
}

function signRelayDeviceRequest({ secret, pairingCode, timestamp, nonce }) {
  return crypto
    .createHmac("sha256", secret)
    .update(["relay.join", pairingCode, timestamp, nonce].join("\n"))
    .digest("base64url");
}

function pruneRelayDeviceNonces(usedDeviceNonces) {
  const now = Date.now();
  for (const [key, expiresAt] of usedDeviceNonces) {
    if (expiresAt <= now) usedDeviceNonces.delete(key);
  }
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function getPeerKey(ws) {
  return ws._socket?.remoteAddress || "unknown";
}
