import http from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  createCommand,
  createEvent,
  validateCommand,
} from "../../../packages/protocol/src/index.mjs";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const MAX_JSON_BODY_BYTES = 64 * 1024;
const TERMINAL_CONTROL_PATTERN = /^[0-9ynqYN]$/;

export function createLocalHost({ adapter, token, host = "127.0.0.1", historyFile = "" }) {
  let server;
  const historyStore = createHistoryStore(historyFile);
  let seq = historyStore.latestSeq;
  const events = [...historyStore.events];
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
    historyStore.append(event);
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

      const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
      if (req.method === "POST" && inputMatch) {
        const sessionId = inputMatch[1];
        const body = await readJson(req);
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
        sendJson(res, 202, await executeCommand(command));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const after = Number(url.searchParams.get("after") || 0);
        const before = Number(url.searchParams.get("before") || 0);
        const limit = Number(url.searchParams.get("limit") || 0);
        sendJson(res, 200, {
          events: selectEvents(events, { after, before, limit }),
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

    if (command.name === "listEvents") {
      const after = Number(command.payload.after || 0);
      const before = Number(command.payload.before || 0);
      const limit = Number(command.payload.limit || 0);
      return {
        events: selectEvents(events, { after, before, limit }),
        latestSeq: seq,
      };
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

    if (command.name === "sendTerminalInput") {
      const text = String(command.payload.text || "");
      if (!text) throw new Error("text is required");
      validateTerminalControlInput(text);
      if (typeof adapter.sendTerminalInput !== "function") {
        throw new Error("adapter does not support terminal input");
      }

      const result = await adapter.sendTerminalInput(command.sessionId, text);
      pushEvent({
        sessionId: command.sessionId,
        conversationId: result.conversationId,
        name: "tool.permissionResolved",
        payload: {
          kind: "permission",
          title: command.payload.label || "已发送确认",
          text: command.payload.label || text,
          status: "completed",
        },
      });
      pushEvent({
        sessionId: command.sessionId,
        conversationId: result.conversationId,
        name: "session.state",
        payload: { status: result.status || "interactive" },
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
      return selectEvents(events, { after });
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

function selectEvents(events, { after = 0, before = 0, limit = 0 } = {}) {
  let selected = events.filter((event) => {
    if (after && event.seq <= after) return false;
    if (before && event.seq >= before) return false;
    return true;
  });

  if (limit > 0 && selected.length > limit) {
    selected = selected.slice(selected.length - limit);
  }

  return selected;
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
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeSse(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.name}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function validateTerminalControlInput(text) {
  if (!TERMINAL_CONTROL_PATTERN.test(text)) {
    throw new Error("terminal input must be a single approved control key");
  }
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
