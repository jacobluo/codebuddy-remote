import { spawn } from "node:child_process";

export class ServeCliAdapter {
  #sessionId = "serve-cli";
  #state = "idle";
  #server = null;
  #client = null;
  #acpSessionId = null;
  #activePrompt = null;

  constructor({
    cliPath = process.env.CODEBUDDY_CLI_PATH || "codebuddy",
    cwd = process.cwd(),
    host = "127.0.0.1",
    port = Number(process.env.CODEBUDDY_SERVE_PORT || 17331),
    stdio = ["ignore", "pipe", "pipe"],
    startServer = startCodeBuddyServe,
    createClient = ({ baseUrl }) => new AcpClient({ baseUrl }),
  } = {}) {
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.host = host;
    this.port = port;
    this.stdio = stdio;
    this.startServer = startServer;
    this.createClient = createClient;
  }

  listSessions() {
    return [
      {
        id: this.#sessionId,
        source: "cli-serve",
        workspace: this.cwd,
        state: this.#state,
      },
    ];
  }

  getState(sessionId) {
    this.#assertSession(sessionId);
    return {
      sessionId,
      source: "cli-serve",
      workspace: this.cwd,
      status: this.#state,
      conversationId: this.#acpSessionId,
    };
  }

  async sendPrompt(sessionId, text) {
    this.#assertSession(sessionId);
    await this.#ensureReady();
    this.#state = "running";

    try {
      this.#activePrompt = this.#client.prompt(this.#acpSessionId, text);
      const result = await this.#activePrompt;
      const assistantText = extractAssistantText(result.messages);
      this.#state = "idle";
      return {
        conversationId: this.#acpSessionId,
        assistantText,
      };
    } catch (error) {
      this.#state = "error";
      throw error;
    } finally {
      this.#activePrompt = null;
    }
  }

  async interrupt(sessionId) {
    this.#assertSession(sessionId);
    if (this.#client && this.#acpSessionId) {
      await this.#client.cancel(this.#acpSessionId);
    }
    this.#state = "interrupted";
    return this.getState(sessionId);
  }

  async resume(sessionId) {
    this.#assertSession(sessionId);
    this.#state = "idle";
    return this.getState(sessionId);
  }

  async close() {
    if (this.#client) await this.#client.disconnect().catch(() => {});
    if (this.#server) await this.#server.close();
    this.#server = null;
    this.#client = null;
  }

  async start() {
    await this.#ensureReady();
  }

  async #ensureReady() {
    if (this.#client && this.#acpSessionId) return;

    const baseUrl = `http://${this.host}:${this.port}`;
    this.#server ||= await this.startServer({
      cliPath: this.cliPath,
      cwd: this.cwd,
      host: this.host,
      port: this.port,
      stdio: this.stdio,
    });
    this.#client ||= this.createClient({ baseUrl });
    await this.#client.connect();
    await this.#client.initialize();
    const session = await this.#client.newSession({ cwd: "." });
    this.#acpSessionId = session.sessionId;
  }

  #assertSession(sessionId) {
    if (sessionId !== this.#sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }
}

export class AcpClient {
  constructor({ baseUrl, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.connectionId = null;
    this.sessionToken = null;
    this.nextId = 1;
  }

  async connect() {
    const response = await this.fetch(`${this.baseUrl}/api/v1/acp/connect`, {
      method: "POST",
      headers: baseHeaders(),
    });
    if (!response.ok) throw new Error(`ACP connect failed: ${response.status}`);
    const body = await response.json();
    this.connectionId = body.connectionId;
    this.sessionToken = body.sessionToken;
    return body;
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "codebuddy-remote-local-host", version: "0.1.0" },
      clientCapabilities: {
        _meta: { "codebuddy.ai": { question: true, promptSuggestion: true } },
      },
    });
  }

  async newSession({ cwd = "." } = {}) {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  async prompt(sessionId, text) {
    const messages = await this.requestMessages("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { messages };
  }

  async cancel(sessionId) {
    return this.notify("session/cancel", { sessionId });
  }

  async disconnect() {
    if (!this.connectionId) return;
    await this.fetch(`${this.baseUrl}/api/v1/acp`, {
      method: "DELETE",
      headers: this.#headers(),
    });
    this.connectionId = null;
    this.sessionToken = null;
  }

  async request(method, params) {
    const messages = await this.requestMessages(method, params);
    const response = messages.find((message) => message.id === this.nextId - 1);
    if (response?.error) throw new Error(response.error.message || method);
    return response?.result || {};
  }

  async notify(method, params) {
    await this.requestMessages(method, params, { id: undefined });
  }

  async requestMessages(method, params, { id = this.nextId++ } = {}) {
    const payload = { jsonrpc: "2.0", method, params };
    if (id !== undefined) payload.id = id;

    const response = await this.fetch(`${this.baseUrl}/api/v1/acp`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`ACP ${method} failed: ${response.status}`);
    return parseSseMessages(await response.text());
  }

  #headers() {
    return {
      ...baseHeaders(),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "acp-connection-id": this.connectionId,
      "acp-session-token": this.sessionToken,
    };
  }
}

export function parseSseMessages(text) {
  const messages = [];
  for (const block of text.split(/\n\n+/)) {
    let data = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) messages.push(JSON.parse(data));
  }
  return messages;
}

export function extractAssistantText(messages) {
  return messages
    .map((message) => message.params?.update)
    .filter((update) => update?.sessionUpdate === "agent_message_chunk")
    .map((update) => update.content?.text || "")
    .join("");
}

function baseHeaders() {
  return { "x-codebuddy-request": "1" };
}

async function startCodeBuddyServe({ cliPath, cwd, host, port, stdio = ["ignore", "pipe", "pipe"] }) {
  const child = spawn(cliPath, ["--serve", "--host", host, "--port", String(port)], {
    cwd,
    env: process.env,
    stdio,
  });

  let stderr = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
  }

  await waitForAcp(`http://${host}:${port}`, child, () => stderr);

  return {
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGINT");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }, 1500).unref();
      });
    },
  };
}

async function waitForAcp(baseUrl, child, getErrorText) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (child.exitCode !== null) {
      throw new Error(`codebuddy --serve exited early: ${getErrorText()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/acp/connect`, {
        method: "POST",
        headers: baseHeaders(),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for codebuddy --serve");
}
