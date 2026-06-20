import { TerminalScreen, normalizeTerminalOutput } from "./terminal-text.js";

const token = new URLSearchParams(window.location.search).get("token") || "dev-token";
let currentSessionId = "mock-session";
let latestSeq = 0;

const connectionState = document.querySelector("#connectionState");
const sessionName = document.querySelector("#sessionName");
const eventsEl = document.querySelector("#events");
const terminalOutput = document.querySelector("#terminalOutput");
const promptForm = document.querySelector("#promptForm");
const promptInput = document.querySelector("#promptInput");
const refreshButton = document.querySelector("#refreshButton");
const interruptButton = document.querySelector("#interruptButton");
const resumeButton = document.querySelector("#resumeButton");
const terminalScreen = new TerminalScreen();

refreshButton.addEventListener("click", refreshSessions);
interruptButton.addEventListener("click", () => runSessionAction("interrupt"));
resumeButton.addEventListener("click", () => runSessionAction("resume"));
promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  await api(`/api/sessions/${currentSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  await refreshEvents();
});

await refreshSessions();
await refreshEvents();
startEventStream();

async function refreshSessions() {
  const data = await api("/api/sessions");
  const [session] = data.sessions;
  if (!session) {
    sessionName.textContent = "没有可用 session";
    return;
  }
  currentSessionId = session.id;
  sessionName.textContent = `${session.id} · ${session.workspace} · ${session.state}`;
  setOnline(true);
}

async function refreshEvents() {
  const data = await api(`/api/events?after=${latestSeq}`);
  for (const event of data.events) appendEvent(event);
  latestSeq = data.latestSeq;
}

async function runSessionAction(action) {
  await api(`/api/sessions/${currentSessionId}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await refreshSessions();
  await refreshEvents();
}

function startEventStream() {
  const source = new EventSource(`/api/events/stream?token=${encodeURIComponent(token)}&after=${latestSeq}`);
  source.onopen = () => setOnline(true);
  source.onerror = () => setOnline(false);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    appendEvent(event);
    latestSeq = Math.max(latestSeq, event.seq);
  };

  for (const name of [
    "session.state",
    "user.message",
    "assistant.delta",
    "assistant.completed",
    "terminal.output",
    "error",
  ]) {
    source.addEventListener(name, (message) => {
      const event = JSON.parse(message.data);
      appendEvent(event);
      latestSeq = Math.max(latestSeq, event.seq);
    });
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  return response.json();
}

function appendEvent(event) {
  if (event.name === "terminal.output") {
    updateTerminal(event.payload?.text || "");
    return;
  }

  const display = displayText(event);
  if (!display) return;

  const item = document.createElement("article");
  item.className = "event";

  const name = document.createElement("span");
  name.className = "event-name";
  name.textContent = `#${event.seq} ${event.name}`;

  const text = document.createElement("p");
  text.className = "event-text";
  text.textContent = display;

  item.append(name, text);
  eventsEl.append(item);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

function updateTerminal(chunk) {
  terminalScreen.write(chunk);
  terminalOutput.textContent = terminalScreen.toString();
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function displayText(event) {
  if (event.name === "terminal.output") {
    return normalizeTerminalOutput(event.payload?.text || "");
  }
  if (event.payload?.text) return event.payload.text;
  if (event.payload?.status) return `状态：${event.payload.status}`;
  return JSON.stringify(event.payload || {});
}

function setOnline(online) {
  connectionState.textContent = online ? "在线" : "离线";
  connectionState.classList.toggle("online", online);
}
