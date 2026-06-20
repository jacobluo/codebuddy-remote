import { spawn } from "node:child_process";

export class RealCliAdapter {
  #sessionId = "real-cli";
  #remoteSessionId = null;
  #state = "idle";
  #activeChild = null;

  constructor({
    cliPath = process.env.CODEBUDDY_CLI_PATH || "codebuddy",
    cwd = process.cwd(),
    runner = runCommand,
    maxTurns = 1,
    extraArgs = [],
  } = {}) {
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.runner = runner;
    this.maxTurns = maxTurns;
    this.extraArgs = extraArgs;
  }

  listSessions() {
    return [
      {
        id: this.#sessionId,
        source: "cli",
        workspace: this.cwd,
        state: this.#state,
      },
    ];
  }

  getState(sessionId) {
    this.#assertSession(sessionId);
    return {
      sessionId,
      source: "cli",
      workspace: this.cwd,
      status: this.#state,
    };
  }

  async sendPrompt(sessionId, text) {
    this.#assertSession(sessionId);
    this.#state = "running";

    try {
      const sessionArgs = this.#remoteSessionId
        ? ["--session-id", this.#remoteSessionId]
        : [];
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--max-turns",
        String(this.maxTurns),
        ...sessionArgs,
        ...this.extraArgs,
        text,
      ];
      const output = await this.runner(this.cliPath, args, {
        cwd: this.cwd,
        onChild: (child) => {
          this.#activeChild = child;
        },
      });
      const parsed = parseStreamJsonLines(output.split(/\r?\n/));
      if (parsed.sessionId) this.#remoteSessionId = parsed.sessionId;
      this.#state = "idle";
      return {
        conversationId: parsed.sessionId || sessionId,
        assistantText: parsed.resultText || "",
      };
    } catch (error) {
      this.#state = "error";
      throw error;
    } finally {
      this.#activeChild = null;
    }
  }

  async interrupt(sessionId) {
    this.#assertSession(sessionId);
    if (this.#activeChild) this.#activeChild.kill("SIGINT");
    this.#state = "interrupted";
    return this.getState(sessionId);
  }

  async resume(sessionId) {
    this.#assertSession(sessionId);
    this.#state = "idle";
    return this.getState(sessionId);
  }

  #assertSession(sessionId) {
    if (sessionId !== this.#sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }
}

export function parseStreamJsonLines(lines) {
  let sessionId;
  let resultText = "";
  let status = "unknown";
  const assistantParts = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.session_id) sessionId = event.session_id;

    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part.type === "text" && part.text) assistantParts.push(part.text);
      }
    }

    if (event.type === "result") {
      status = event.subtype || (event.is_error ? "error" : "success");
      if (typeof event.result === "string") resultText = event.result;
    }
  }

  return {
    sessionId,
    resultText: resultText || assistantParts.join(""),
    status,
  };
}

function runCommand(command, args, { cwd, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (onChild) onChild(child);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `CodeBuddy CLI exited with ${signal || code}: ${stderr || stdout}`
        )
      );
    });
  });
}
