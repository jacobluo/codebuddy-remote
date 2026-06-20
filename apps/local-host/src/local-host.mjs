import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCommand,
  createEvent,
  validateCommand,
} from "../../../packages/protocol/src/index.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(MODULE_DIR, "..", "..", "mobile-web", "public");

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function createLocalHost({ adapter, token, host = "127.0.0.1" }) {
  let server;
  let seq = 0;
  const events = [];
  const subscribers = new Set();

  adapter.onEvent?.((event) => {
    pushEvent(event);
  });

  function pushEvent({ sessionId, conversationId, name, payload }) {
    const event = createEvent({
      sessionId,
      conversationId,
      seq: ++seq,
      name,
      payload,
    });
    events.push(event);
    for (const subscriber of subscribers) subscriber(event);
    return event;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && isStaticPath(url.pathname)) {
        await serveStatic(res, url.pathname);
        return;
      }

      if (!isAuthorized(req, url, token)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        sendJson(res, 200, await executeCommand(createCommand({
          sessionId: "local-host",
          name: "listSessions",
          payload: {},
        })));
        return;
      }

      const stateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/state$/);
      if (req.method === "GET" && stateMatch) {
        sendJson(res, 200, await executeCommand(createCommand({
          sessionId: stateMatch[1],
          name: "getState",
          payload: {},
        })));
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === "POST" && messageMatch) {
        const sessionId = messageMatch[1];
        const body = await readJson(req);
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
        sendJson(res, 202, await executeCommand(command));
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
        sendJson(res, 202, await executeCommand(command));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const after = Number(url.searchParams.get("after") || 0);
        sendJson(res, 200, {
          events: events.filter((event) => event.seq > after),
          latestSeq: seq,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events/stream") {
        const after = Number(url.searchParams.get("after") || 0);
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

    for (const event of events.filter((item) => item.seq > after)) {
      writeSse(res, event);
    }

    const subscriber = (event) => writeSse(res, event);
    subscribers.add(subscriber);
    res.on("close", () => subscribers.delete(subscriber));
  }

  async function executeCommand(command) {
    validateCommand(command);

    if (command.name === "listSessions") {
      return { sessions: adapter.listSessions() };
    }

    if (command.name === "getState") {
      return { state: adapter.getState(command.sessionId) };
    }

    if (command.name === "sendPrompt") {
      const text = String(command.payload.text || "").trim();
      if (!text) throw new Error("text is required");

      pushEvent({
        sessionId: command.sessionId,
        name: "user.message",
        payload: { text },
      });
      pushEvent({
        sessionId: command.sessionId,
        name: "session.state",
        payload: { status: "running" },
      });

      const result = await adapter.sendPrompt(command.sessionId, text);
      if (!result.terminalOnly) {
        pushEvent({
          sessionId: command.sessionId,
          conversationId: result.conversationId,
          name: "assistant.delta",
          payload: { text: result.assistantText },
        });
        pushEvent({
          sessionId: command.sessionId,
          conversationId: result.conversationId,
          name: "assistant.completed",
          payload: {},
        });
      }
      pushEvent({
        sessionId: command.sessionId,
        conversationId: result.conversationId,
        name: "session.state",
        payload: { status: result.status || "idle" },
      });

      return { command };
    }

    if (command.name === "interrupt" || command.name === "resume") {
      const state =
        command.name === "interrupt"
          ? await adapter.interrupt(command.sessionId)
          : await adapter.resume(command.sessionId);

      pushEvent({
        sessionId: command.sessionId,
        name: "session.state",
        payload: { status: state.status },
      });

      return { command, state };
    }

    throw new Error(`unsupported command: ${command.name}`);
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
    pushEvent,
    handleCommand: executeCommand,
    getEvents({ after = 0 } = {}) {
      return events.filter((event) => event.seq > after);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

function isAuthorized(req, url, token) {
  if (!token) return true;
  if (url.searchParams.get("token") === token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeSse(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.name}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isStaticPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/app.js" ||
    pathname === "/terminal-text.js" ||
    pathname === "/styles.css"
  );
}

async function serveStatic(res, pathname) {
  const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.join(WEB_ROOT, fileName);
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType(fileName),
    "cache-control": "no-store",
  });
  res.end(content);
}

function contentType(fileName) {
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
