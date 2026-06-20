#!/usr/bin/env node
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createLocalHost } from "./local-host.mjs";
import { connectRelay } from "./relay-client.mjs";
import { TerminalCliAdapter } from "./terminal-cli-adapter.mjs";

export function createRunConfig({ cwd = process.cwd(), env = process.env } = {}) {
  return {
    cwd,
    cliPath: env.CODEBUDDY_CLI_PATH || "codebuddy",
    host: env.CODEBUDDY_REMOTE_HOST || "0.0.0.0",
    port: Number(env.CODEBUDDY_REMOTE_PORT || 17320),
    token: env.CODEBUDDY_REMOTE_TOKEN || createToken(),
    relayUrl: env.CODEBUDDY_REMOTE_RELAY_URL || "",
    relayToken: env.CODEBUDDY_REMOTE_RELAY_TOKEN || "",
    pairingCode: env.CODEBUDDY_REMOTE_PAIRING_CODE || createPairingCode(),
  };
}

export function buildStartupUrls({
  port,
  token,
  host,
  interfaces = os.networkInterfaces(),
}) {
  const urls = [`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`];
  if (host === "127.0.0.1" || host === "localhost") return urls;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`http://${entry.address}:${port}/?token=${encodeURIComponent(token)}`);
    }
  }
  return [...new Set(urls)];
}

export function createAdapterOptions(config) {
  return {
    cwd: config.cwd,
    cliPath: config.cliPath,
    args: [],
  };
}

export function formatHelp() {
  return `Usage: codebuddy-remote [--help]

Starts a local CodeBuddy CLI session and exposes it to CodeBuddy Remote clients.

Environment:
  CODEBUDDY_CLI_PATH              CodeBuddy executable, default: codebuddy
  CODEBUDDY_REMOTE_HOST           Local HTTP host, default: 0.0.0.0
  CODEBUDDY_REMOTE_PORT           Local HTTP port, default: 17320
  CODEBUDDY_REMOTE_TOKEN          Local HTTP token, generated when omitted
  CODEBUDDY_REMOTE_RELAY_URL      Relay WebSocket URL, optional
  CODEBUDDY_REMOTE_RELAY_TOKEN    Relay auth token, optional
  CODEBUDDY_REMOTE_PAIRING_CODE   Relay pairing code, generated when omitted
`;
}

export function isCliEntry({
  metaUrl = import.meta.url,
  argv1 = process.argv[1],
  realpathSync: resolveRealpath = realpathSync,
} = {}) {
  if (!argv1) return false;

  const modulePath = fileURLToPath(metaUrl);
  return safeRealpath(modulePath, resolveRealpath) === safeRealpath(argv1, resolveRealpath);
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(formatHelp());
    return;
  }

  const config = createRunConfig();
  const adapter = new TerminalCliAdapter(createAdapterOptions(config));
  const host = createLocalHost({
    adapter,
    token: config.token,
    host: config.host,
  });
  const relay = connectRelay({
    relayUrl: config.relayUrl,
    relayToken: config.relayToken,
    pairingCode: config.pairingCode,
    host,
    meta: {
      workspace: config.cwd,
      source: "codebuddy-remote",
    },
  });

  const server = await host.listen(config.port);
  const address = server.address();
  const actualPort = address.port;
  const urls = buildStartupUrls({
    port: actualPort,
    token: config.token,
    host: config.host,
  });

  console.log("");
  console.log("  CodeBuddy Remote");
  console.log("");
  console.log(`  Workspace   ${config.cwd}`);
  console.log(`  Local Host  http://${config.host}:${actualPort}`);
  console.log(`  CodeBuddy   ${config.cliPath}`);
  if (config.relayUrl) {
    console.log(`  Relay       ${config.relayUrl}`);
    console.log(`  Pairing     ${config.pairingCode}`);
  }
  console.log("");
  console.log("  Open on phone:");
  for (const url of urls) console.log(`  ${url}`);
  console.log("");
  console.log("  Press Ctrl+C to stop");
  console.log("");

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[codebuddy-remote] received ${signal}, shutting down`);
    try {
      await host.close();
      relay?.close();
      process.exit(0);
    } catch (error) {
      console.error("[codebuddy-remote] shutdown failed", error);
      process.exit(1);
    }
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await adapter.start();
  void adapter.waitForExit().then(() => shutdown("CodeBuddy exited"));
}

function createToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function createPairingCode() {
  return crypto.randomBytes(4).toString("base64url").toUpperCase();
}

function safeRealpath(candidate, resolveRealpath) {
  try {
    return resolveRealpath(candidate);
  } catch {
    return candidate;
  }
}

if (isCliEntry()) {
  void main();
}
