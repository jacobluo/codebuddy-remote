export const COMMAND_NAMES = new Set([
  "listSessions",
  "selectSession",
  "sendPrompt",
  "approveTool",
  "rejectTool",
  "interrupt",
  "resume",
  "getState",
  "openInDesktop",
]);

export const EVENT_NAMES = new Set([
  "session.created",
  "session.selected",
  "session.state",
  "user.message",
  "assistant.delta",
  "assistant.completed",
  "tool.requested",
  "tool.output",
  "tool.permissionRequested",
  "tool.permissionResolved",
  "diff.created",
  "terminal.output",
  "error",
  "connection.resumed",
]);

let commandCounter = 0;

export function createCommand({ sessionId, name, payload = {} }) {
  const command = {
    type: "command",
    id: `cmd_${Date.now()}_${++commandCounter}`,
    sessionId,
    name,
    payload,
  };
  validateCommand(command);
  return command;
}

export function createEvent({
  sessionId,
  conversationId,
  seq,
  name,
  payload = {},
}) {
  const event = {
    type: "event",
    id: `evt_${seq}`,
    sessionId,
    seq,
    name,
    payload,
  };
  if (conversationId) event.conversationId = conversationId;
  validateEvent(event);
  return event;
}

export function validateCommand(command) {
  assertObject(command, "command");
  if (command.type !== "command") throw new Error("command.type must be command");
  if (!command.id) throw new Error("command.id is required");
  if (!command.sessionId) throw new Error("command.sessionId is required");
  if (!COMMAND_NAMES.has(command.name)) {
    throw new Error(`unknown command: ${command.name}`);
  }
  assertObject(command.payload, "command.payload");
  return command;
}

export function validateEvent(event) {
  assertObject(event, "event");
  if (event.type !== "event") throw new Error("event.type must be event");
  if (!event.id) throw new Error("event.id is required");
  if (!event.sessionId) throw new Error("event.sessionId is required");
  if (!Number.isInteger(event.seq) || event.seq < 1) {
    throw new Error("event.seq must be a positive integer");
  }
  if (!EVENT_NAMES.has(event.name)) {
    throw new Error(`unknown event: ${event.name}`);
  }
  assertObject(event.payload, "event.payload");
  return event;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}
