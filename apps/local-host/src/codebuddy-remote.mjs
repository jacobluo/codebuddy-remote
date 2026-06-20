#!/usr/bin/env node
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

import { createLocalHost } from "./local-host.mjs";
import { connectRelay } from "./relay-client.mjs";
import { TerminalCliAdapter } from "./terminal-cli-adapter.mjs";

export function createRunConfig({
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  return {
    cwd,
    cliPath: env.CODEBUDDY_CLI_PATH || "codebuddy",
    host: env.CODEBUDDY_REMOTE_HOST || "0.0.0.0",
    port: Number(env.CODEBUDDY_REMOTE_PORT || 17320),
    token: env.CODEBUDDY_REMOTE_TOKEN || createToken(),
    relayUrl: env.CODEBUDDY_REMOTE_RELAY_URL || "",
    relayToken: env.CODEBUDDY_REMOTE_RELAY_TOKEN || "",
    pairingCode: env.CODEBUDDY_REMOTE_PAIRING_CODE || createPairingCode(),
    historyFile: env.CODEBUDDY_REMOTE_HISTORY_FILE || defaultHistoryFile(cwd, homeDir),
    deviceStoreFile: env.CODEBUDDY_REMOTE_DEVICE_STORE_FILE || defaultDeviceStoreFile(homeDir),
  };
}

export function buildStartupUrls({
  port,
  host,
  interfaces = os.networkInterfaces(),
}) {
  const urls = [`http://127.0.0.1:${port}`];
  if (host === "127.0.0.1" || host === "localhost") return urls;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

export function buildPairingPayload({
  config,
  urls,
  hostName = os.hostname(),
  now = Date.now(),
  ttlMs = 120000,
}) {
  const workspace = path.basename(config.cwd) || config.cwd;
  const common = {
    v: "1",
    expiresAt: String(now + ttlMs),
    workspace,
    host: hostName,
  };

  if (config.relayUrl) {
    return {
      ...common,
      mode: "relay",
      relayURL: config.relayUrl,
      relayToken: config.relayToken,
      pairingCode: config.pairingCode,
    };
  }

  return {
    ...common,
    mode: "local",
    baseURL: selectPairingBaseUrl(urls),
    token: config.token,
  };
}

export function createPairingUrl(payload) {
  const url = new URL("cbr://pair");
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
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
  CODEBUDDY_REMOTE_HISTORY_FILE   Event history JSONL file, default: ~/.codebuddy-remote/history/<workspace>.jsonl
  CODEBUDDY_REMOTE_DEVICE_STORE_FILE Bound device list, default: ~/.codebuddy-remote/devices.json
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
    historyFile: config.historyFile,
    deviceStoreFile: config.deviceStoreFile,
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
    host: config.host,
  });
  const pairingUrl = createPairingUrl(buildPairingPayload({ config, urls }));

  console.log("");
  console.log("  CodeBuddy Remote");
  console.log("");
  console.log(`  Workspace   ${config.cwd}`);
  console.log(`  Local Host  http://${config.host}:${actualPort}`);
  console.log(`  Local Token ${config.token}`);
  console.log(`  CodeBuddy   ${config.cliPath}`);
  console.log(`  History     ${config.historyFile}`);
  console.log(`  Devices     ${config.deviceStoreFile}`);
  if (config.relayUrl) {
    console.log(`  Relay       ${config.relayUrl}`);
    console.log(`  Pairing     ${config.pairingCode}`);
  }
  console.log("");
  console.log("  iOS app Local API candidates:");
  for (const url of urls) console.log(`  ${url}`);
  console.log("");
  console.log("  Scan with CodeBuddyRemote iOS app:");
  qrcode.generate(pairingUrl, { small: true });
  console.log("");
  console.log(`  Pairing URL ${pairingUrl}`);
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

function defaultHistoryFile(cwd, homeDir) {
  const workspaceName = path.basename(cwd) || "workspace";
  const safeName = workspaceName.replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(homeDir, ".codebuddy-remote", "history", `${safeName}-${hash}.jsonl`);
}

function defaultDeviceStoreFile(homeDir) {
  return path.join(homeDir, ".codebuddy-remote", "devices.json");
}

function selectPairingBaseUrl(urls) {
  return urls.find((url) => !url.includes("127.0.0.1") && !url.includes("localhost")) || urls[0] || "";
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
