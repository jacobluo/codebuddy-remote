import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TerminalSemanticParser } from "../terminal/terminal-semantic-parser.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PTY_BRIDGE = path.join(MODULE_DIR, "../terminal/pty-bridge.py");

export class TerminalCliAdapter {
  #sessionId = "terminal-cli";
  #state = "idle";
  #terminal = null;
  #subscribers = new Set();

  constructor({
    cliPath = process.env.CODEBUDDY_CLI_PATH || "codebuddy",
    args = [],
    cwd = process.cwd(),
    startTerminal = startPythonPtyTerminal,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    env = process.env,
    submitDelayMs = 50,
    clearInputSequence = "\x1b\x1b",
    semanticParser = new TerminalSemanticParser(),
  } = {}) {
    this.cliPath = cliPath;
    this.args = args;
    this.cwd = cwd;
    this.startTerminal = startTerminal;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.env = env;
    this.submitDelayMs = submitDelayMs;
    this.clearInputSequence = clearInputSequence;
    this.semanticParser = semanticParser;
  }

  listSessions() {
    return [
      {
        id: this.#sessionId,
        source: "cli-terminal",
        workspace: this.cwd,
        state: this.#state,
      },
    ];
  }

  getState(sessionId) {
    this.#assertSession(sessionId);
    return {
      sessionId,
      source: "cli-terminal",
      workspace: this.cwd,
      status: this.#state,
      conversationId: this.#sessionId,
    };
  }

  onEvent(subscriber) {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  async start() {
    if (this.#terminal) return;
    this.#terminal = await this.startTerminal({
      cliPath: this.cliPath,
      args: this.args,
      cwd: this.cwd,
      input: this.input,
      output: this.output,
      errorOutput: this.errorOutput,
      env: this.env,
      onData: (chunk) => this.#emitTerminalOutput(chunk),
      onExit: () => {
        this.#state = "exited";
      },
    });
    this.#state = "interactive";
  }

  async sendPrompt(sessionId, text) {
    this.#assertSession(sessionId);
    await this.start();
    if (this.clearInputSequence) {
      this.#terminal.write(this.clearInputSequence);
      await delay(this.submitDelayMs);
    }
    this.#terminal.write(text);
    await delay(this.submitDelayMs);
    this.#terminal.write("\r");
    this.#state = "interactive";
    return {
      conversationId: this.#sessionId,
      assistantText: "",
      terminalOnly: true,
      status: this.#state,
    };
  }

  async sendTerminalInput(sessionId, text) {
    this.#assertSession(sessionId);
    await this.start();
    this.#terminal.write(text);
    await delay(this.submitDelayMs);
    this.#terminal.write("\r");
    this.#state = "interactive";
    return {
      conversationId: this.#sessionId,
      terminalOnly: true,
      status: this.#state,
    };
  }

  async interrupt(sessionId) {
    this.#assertSession(sessionId);
    if (this.#terminal) this.#terminal.write("\x03");
    this.#state = "interactive";
    return this.getState(sessionId);
  }

  async resume(sessionId) {
    this.#assertSession(sessionId);
    this.#state = this.#terminal ? "interactive" : "idle";
    return this.getState(sessionId);
  }

  async close() {
    if (this.#terminal) await this.#terminal.close();
    this.#terminal = null;
    this.#state = "idle";
  }

  waitForExit() {
    return this.#terminal?.closed || new Promise(() => {});
  }

  #emitTerminalOutput(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!text) return;
    const event = {
      sessionId: this.#sessionId,
      conversationId: this.#sessionId,
      name: "terminal.output",
      payload: { text },
    };
    for (const subscriber of this.#subscribers) subscriber(event);
    for (const semantic of this.semanticParser.write(text)) {
      const semanticEvent = {
        sessionId: this.#sessionId,
        conversationId: this.#sessionId,
        name: semantic.name,
        payload: semantic.payload,
      };
      for (const subscriber of this.#subscribers) subscriber(semanticEvent);
    }
  }

  #assertSession(sessionId) {
    if (sessionId !== this.#sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startPythonPtyTerminal({
  cliPath,
  args = [],
  cwd,
  input,
  output,
  errorOutput,
  env,
  onData,
  onExit,
  pythonPath = process.env.CODEBUDDY_REMOTE_PYTHON || "python3",
}) {
  const child = spawn(pythonPath, [PTY_BRIDGE, cliPath, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let rawModeWasEnabled = false;
  let rawModeChanged = false;
  const forwardInput = (chunk) => {
    if (!child.stdin.destroyed) child.stdin.write(chunk);
  };

  if (input?.on) {
    if (input.isTTY && typeof input.setRawMode === "function") {
      rawModeWasEnabled = Boolean(input.isRaw);
      input.setRawMode(true);
      rawModeChanged = true;
    }
    input.resume?.();
    input.on("data", forwardInput);
  }

  child.stdout.on("data", (chunk) => {
    output?.write?.(chunk);
    onData?.(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorOutput?.write?.(chunk);
    onData?.(chunk);
  });

  const closed = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      cleanup();
      onExit?.({ code, signal });
      resolve({ code, signal });
    });
  });

  function cleanup() {
    input?.off?.("data", forwardInput);
    if (rawModeChanged && input.isTTY && typeof input.setRawMode === "function") {
      input.setRawMode(rawModeWasEnabled);
    }
  }

  return {
    write(text) {
      if (!child.stdin.destroyed) child.stdin.write(text);
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) {
          cleanup();
          resolve();
          return;
        }
        closed.then(() => resolve());
        child.kill("SIGINT");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }, 1500).unref();
      });
    },
    closed,
  };
}
