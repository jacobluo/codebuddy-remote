import {
  createEvent,
  validateCommand,
} from "../../../packages/protocol/src/index.mjs";

const TERMINAL_CONTROL_PATTERN = /^[0-9ynqYN]$/;

export function createSessionCommandWorkflow({
  adapter,
  events: initialEvents = [],
  latestSeq = 0,
  onEvent,
} = {}) {
  if (!adapter) throw new Error("adapter is required");

  let seq = latestSeq;
  const events = [...initialEvents];
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
    onEvent?.(event);
    for (const subscriber of subscribers) subscriber(event);
    return event;
  }

  async function handleCommand(command) {
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
    pushEvent,
    handleCommand,
    getEvents({ after = 0, before = 0, limit = 0 } = {}) {
      return selectEvents(events, { after, before, limit });
    },
    get latestSeq() {
      return seq;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

export function selectEvents(events, { after = 0, before = 0, limit = 0 } = {}) {
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

function validateTerminalControlInput(text) {
  if (!TERMINAL_CONTROL_PATTERN.test(text)) {
    throw new Error("terminal input must be a single approved control key");
  }
}
