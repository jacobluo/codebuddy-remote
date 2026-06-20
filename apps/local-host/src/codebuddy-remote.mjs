#!/usr/bin/env node
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createLocalHost } from "./local-host.mjs";
import { TerminalCliAdapter } from "./terminal-cli-adapter.mjs";

export function createRunConfig({ cwd = process.cwd(), env = process.env } = {}) {
  return {
    cwd,
    cliPath: env.CODEBUDDY_CLI_PATH || "codebuddy",
    host: env.CODEBUDDY_REMOTE_HOST || "0.0.0.0",
    port: Number(env.CODEBUDDY_REMOTE_PORT || 17320),
    token: env.CODEBUDDY_REMOTE_TOKEN || createToken(),
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
  const config = createRunConfig();
  const adapter = new TerminalCliAdapter(createAdapterOptions(config));
  const host = createLocalHost({
    adapter,
    token: config.token,
    host: config.host,
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
