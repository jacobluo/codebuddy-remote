import http from "node:http";
import crypto from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  createCommand,
} from "../../../packages/protocol/src/index.mjs";
import {
  createSessionCommandWorkflow,
} from "./session-command-workflow.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_DEVICE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function createLocalHost({
  adapter,
  token,
  bindToken = "",
  host = "127.0.0.1",
  historyFile = "",
  deviceStoreFile = "",
  auditFile = "",
}) {
  let server;
  const historyStore = createHistoryStore(historyFile);
  const deviceStore = createDeviceStore(deviceStoreFile);
  const auditStore = createAuditStore(auditFile);
  let bindTokenConsumed = false;
  const workflow = createSessionCommandWorkflow({
    adapter,
    events: historyStore.events,
    latestSeq: historyStore.latestSeq,
    onEvent(event) {
      historyStore.append(event);
    },
  });

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const requestPayload = shouldReadBody(req)
        ? await readJsonPayload(req)
        : { body: {}, rawBody: "" };
      const requestBody = requestPayload.body;
      const auth = authorizeRequest(req, url, {
        token,
        bindToken,
        bindTokenConsumed,
        deviceStore,
        rawBody: requestPayload.rawBody,
      });

      if (!auth.authorized) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/devices/bind") {
        if (auth.type !== "admin" && auth.type !== "bind") {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const device = deviceStore.bind({
          deviceId: String(requestBody.deviceId || ""),
          deviceSecret: String(requestBody.deviceSecret || ""),
          deviceName: String(requestBody.deviceName || "CodeBuddy Remote"),
        });
        if (auth.type === "bind") bindTokenConsumed = true;
        audit("device.bound", {
          authType: auth.type,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
        });
        sendJson(res, 200, {
          ok: true,
          device: {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            createdAt: device.createdAt,
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/devices") {
        if (auth.type !== "admin") {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        sendJson(res, 200, { devices: deviceStore.list() });
        return;
      }

      const renameDeviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (req.method === "PATCH" && renameDeviceMatch) {
        if (auth.type !== "admin") {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const device = deviceStore.rename(
          decodeURIComponent(renameDeviceMatch[1]),
          String(requestBody.deviceName || "")
        );
        audit("device.renamed", {
          authType: auth.type,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
        });
        sendJson(res, 200, { ok: true, device: sanitizeDevice(device) });
        return;
      }

      const revokeDeviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
      if (req.method === "POST" && revokeDeviceMatch) {
        if (auth.type !== "admin") {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const device = deviceStore.revoke(decodeURIComponent(revokeDeviceMatch[1]));
        audit("device.revoked", {
          authType: auth.type,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
        });
        sendJson(res, 200, { ok: true, device: sanitizeDevice(device) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/audit") {
        if (auth.type !== "admin") {
          sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
        const limit = Number(url.searchParams.get("limit") || 100);
        sendJson(res, 200, { entries: auditStore.list({ limit }) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        sendJson(res, 200, await workflow.handleCommand(createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        })));
        return;
      }

      const stateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/state$/);
      if (req.method === "GET" && stateMatch) {
        sendJson(res, 200, await workflow.handleCommand(createCommand({
          sessionId: stateMatch[1],
          name: "getState",
          payload: {},
        })));
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && messageMatch) {
        const sessionId = messageMatch[1];
        const body = requestBody;
        const text = String(body.text || "").trim();
        if (!text) {
          sendJson(res, 400, { ok: false, error: "text is required" });
          return;
        }

        const command = createCommand({
          sessionId,
          name: "sendPrompt",
          payload: { text, mode: body.mode || "craft" },
        });
        audit("prompt.sent", {
          authType: auth.type,
          deviceId: auth.deviceId,
          sessionId,
          promptLength: text.length,
          promptSha256: crypto.createHash("sha256").update(text).digest("hex"),
        });
        sendJson(res, 202, await workflow.handleCommand(command));
        return;
      }

      const actionMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/(interrupt|resume)$/
      );
      if (req.method === "POST" && actionMatch) {
        const [, sessionId, action] = actionMatch;
        const command = createCommand({
          sessionId,
          name: action,
          payload: {},
        });
        audit(`session.${action}`, {
          authType: auth.type,
          deviceId: auth.deviceId,
          sessionId,
        });
        sendJson(res, 202, await workflow.handleCommand(command));
        return;
      }

      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === "POST" && inputMatch) {
        const sessionId = inputMatch[1];
        const body = requestBody;
        const text = String(body.text || "");
        if (!text) {
          sendJson(res, 400, { ok: false, error: "text is required" });
          return;
        }

        const command = createCommand({
          sessionId,
          name: "sendTerminalInput",
          payload: { text, label: body.label || "" },
        });
        audit("approval.input", {
          authType: auth.type,
          deviceId: auth.deviceId,
          sessionId,
          label: body.label || "",
        });
        sendJson(res, 202, await workflow.handleCommand(command));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const after = Number(url.searchParams.get("after") || 0);
        const before = Number(url.searchParams.get("before") || 0);
        const limit = Number(url.searchParams.get("limit") || 0);
        sendJson(res, 200, {
          events: workflow.getEvents({ after, before, limit }),
          latestSeq: workflow.latestSeq,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events/stream") {
        const after = Number(url.searchParams.get("after") || 0);
        audit("connection.stream", {
          authType: auth.type,
          deviceId: auth.deviceId,
          after,
        });
        streamEvents(res, after);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function streamEvents(res, after) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });

    for (const event of workflow.getEvents({ after })) {
      writeSse(res, event);
    }

    const subscriber = (event) => writeSse(res, event);
    const unsubscribe = workflow.subscribe(subscriber);
    res.on("close", unsubscribe);
  }

  function audit(type, fields = {}) {
    auditStore.append({
      type,
      at: new Date().toISOString(),
      ...Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")
      ),
    });
  }

  return {
    listen(port = 17320) {
      server = http.createServer(handle);
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        const closeServer = server
          ? new Promise((serverResolve, serverReject) => {
              server.close((error) => {
                if (error) serverReject(error);
                else serverResolve();
              });
            })
          : Promise.resolve();
        closeServer
          .then(() => adapter.close?.())
          .then(resolve, reject);
      });
    },
    pushEvent: workflow.pushEvent,
    handleCommand: workflow.handleCommand,
    getEvents({ after = 0 } = {}) {
      return workflow.getEvents({ after });
    },
    subscribe(subscriber) {
      return workflow.subscribe(subscriber);
    },
  };
}

function authorizeRequest(req, url, {
  token,
  bindToken,
  bindTokenConsumed,
  deviceStore,
  rawBody = "",
}) {
  if (!token) return { authorized: true, type: "admin" };
  if (url.searchParams.get("token") === token && isLocalAdminRequest(req)) {
    return { authorized: true, type: "admin" };
  }
  if (req.headers.authorization === `Bearer ${token}` && isLocalAdminRequest(req)) {
    return { authorized: true, type: "admin" };
  }
  if (
    bindToken &&
    !bindTokenConsumed &&
    req.method === "POST" &&
    url.pathname === "/api/devices/bind" &&
    req.headers.authorization === `Bearer ${bindToken}`
  ) {
    return { authorized: true, type: "bind" };
  }

  const verifiedDevice = deviceStore.verifyRequest({
    method: req.method || "GET",
    path: url.pathname,
    body: rawBody,
    deviceId: req.headers["x-codebuddy-device-id"],
    timestamp: req.headers["x-codebuddy-timestamp"],
    nonce: req.headers["x-codebuddy-nonce"],
    signature: req.headers["x-codebuddy-signature"],
  });
  if (verifiedDevice) {
    return { authorized: true, type: "device", deviceId: verifiedDevice.deviceId };
  }
  return { authorized: false, type: "none" };
}

function isLocalAdminRequest(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (forwardedFor && !isLoopbackAddress(forwardedFor)) return false;
  return isLoopbackAddress(req.socket?.remoteAddress || "");
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(address);
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJsonPayload(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return { body: {}, rawBody: "" };
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return { body: JSON.parse(rawBody), rawBody };
}

function shouldReadBody(req) {
  return !["GET", "HEAD"].includes(req.method || "GET");
}

function writeSse(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.name}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createHistoryStore(historyFile) {
  if (!historyFile) {
    return {
      events: [],
      latestSeq: 0,
      append() {},
    };
  }

  const events = loadHistoryEvents(historyFile);
  let latestSeq = events.reduce((maxSeq, event) => Math.max(maxSeq, event.seq || 0), 0);

  return {
    events,
    get latestSeq() {
      return latestSeq;
    },
    append(event) {
      if (!shouldPersistEvent(event)) return;
      try {
        mkdirSync(dirname(historyFile), { recursive: true });
        appendFileSync(historyFile, `${JSON.stringify(event)}\n`, "utf8");
        latestSeq = Math.max(latestSeq, event.seq || 0);
      } catch (error) {
        console.warn(
          "[codebuddy-remote] failed to persist event history:",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
}

function createAuditStore(auditFile) {
  if (!auditFile) {
    return { append() {}, list() { return []; } };
  }

  return {
    append(entry) {
      try {
        mkdirSync(dirname(auditFile), { recursive: true });
        appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        console.warn(
          "[codebuddy-remote] failed to write audit log:",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    list({ limit = 100 } = {}) {
      if (!existsSync(auditFile)) return [];
      try {
        const entries = readFileSync(auditFile, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        if (limit > 0 && entries.length > limit) {
          return entries.slice(entries.length - limit);
        }
        return entries;
      } catch {
        return [];
      }
    },
  };
}

function loadHistoryEvents(historyFile) {
  if (!existsSync(historyFile)) return [];

  try {
    return readFileSync(historyFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .filter((event) => event && typeof event.seq === "number");
  } catch (error) {
    console.warn(
      "[codebuddy-remote] failed to load event history:",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

function shouldPersistEvent(event) {
  return event.name !== "terminal.output";
}

function createDeviceStore(deviceStoreFile) {
  const devices = loadDevices(deviceStoreFile);
  const usedNonces = new Map();

  return {
    bind({ deviceId, deviceSecret, deviceName }) {
      if (!deviceId) throw new Error("deviceId is required");
      if (!deviceSecret) throw new Error("deviceSecret is required");

      const now = new Date().toISOString();
      const existing = devices.find((device) => device.deviceId === deviceId);
      const device = {
        deviceId,
        deviceSecret,
        deviceName: deviceName || "CodeBuddy Remote",
        createdAt: existing?.createdAt || now,
        lastSeenAt: now,
        revoked: false,
      };

      if (existing) {
        Object.assign(existing, device);
      } else {
        devices.push(device);
      }
      saveDevices(deviceStoreFile, devices);
      return device;
    },
    list() {
      return devices.map(sanitizeDevice);
    },
    revoke(deviceId) {
      const device = devices.find((item) => item.deviceId === deviceId);
      if (!device) throw new Error("device not found");
      device.revoked = true;
      device.revokedAt = new Date().toISOString();
      saveDevices(deviceStoreFile, devices);
      return device;
    },
    rename(deviceId, deviceName) {
      const device = devices.find((item) => item.deviceId === deviceId);
      if (!device) throw new Error("device not found");
      const normalizedName = String(deviceName || "").trim();
      if (!normalizedName) throw new Error("deviceName is required");
      device.deviceName = normalizedName;
      device.updatedAt = new Date().toISOString();
      saveDevices(deviceStoreFile, devices);
      return device;
    },
    verifyRequest({ method, path, body, deviceId, timestamp, nonce, signature }) {
      if (!deviceId || !timestamp || !nonce || !signature) return false;
      const device = devices.find((item) => item.deviceId === deviceId && !item.revoked);
      if (!device) return false;

      const requestTime = Number(timestamp);
      if (!Number.isFinite(requestTime)) return false;
      if (Math.abs(Date.now() - requestTime) > MAX_DEVICE_CLOCK_SKEW_MS) return false;
      pruneUsedNonces(usedNonces);
      const nonceKey = `${deviceId}:${nonce}`;
      if (usedNonces.has(nonceKey)) return false;

      const expected = signDeviceRequest({
        secret: device.deviceSecret,
        method,
        path,
        body,
        timestamp,
        nonce,
      });
      if (!timingSafeStringEqual(String(signature), expected)) return false;
      usedNonces.set(nonceKey, Date.now() + MAX_DEVICE_CLOCK_SKEW_MS);
      device.lastSeenAt = new Date().toISOString();
      saveDevices(deviceStoreFile, devices);
      return sanitizeDevice(device);
    },
  };
}

function pruneUsedNonces(usedNonces) {
  const now = Date.now();
  for (const [key, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(key);
  }
}

function sanitizeDevice(device) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revoked: Boolean(device.revoked),
  };
}

function loadDevices(deviceStoreFile) {
  if (!deviceStoreFile || !existsSync(deviceStoreFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(deviceStoreFile, "utf8"));
    return Array.isArray(parsed.devices) ? parsed.devices : [];
  } catch {
    return [];
  }
}

function saveDevices(deviceStoreFile, devices) {
  if (!deviceStoreFile) return;
  mkdirSync(dirname(deviceStoreFile), { recursive: true });
  const body = `${JSON.stringify({ devices }, null, 2)}\n`;
  writeFileSync(deviceStoreFile, body, { encoding: "utf8", mode: 0o600 });
}

function signDeviceRequest({ secret, method, path, body, timestamp, nonce }) {
  return crypto
    .createHmac("sha256", secret)
    .update([method, path, body, timestamp, nonce].join("\n"))
    .digest("base64url");
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
