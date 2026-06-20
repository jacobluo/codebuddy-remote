import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildPairingPayload,
  createPairingUrl,
  createAdapterOptions,
  createRunConfig,
  formatHelp,
  isCliEntry,
} from "../apps/local-host/src/codebuddy-remote.mjs";

test("codebuddy-remote exposes the expected package bin", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.bin["codebuddy-remote"], "./apps/local-host/src/codebuddy-remote.mjs");
});

test("codebuddy-remote creates a run config from the current workspace", () => {
  const config = createRunConfig({
    cwd: "/Users/robiluo/aicoding/drink",
    homeDir: "/Users/robiluo",
    env: {
      CODEBUDDY_REMOTE_HOST: "127.0.0.1",
      CODEBUDDY_REMOTE_PORT: "18080",
      CODEBUDDY_CLI_PATH: "custom-codebuddy",
      CODEBUDDY_REMOTE_TOKEN: "fixed-token",
      CODEBUDDY_REMOTE_BIND_TOKEN: "bind-once",
      CODEBUDDY_REMOTE_RELAY_URL: "ws://relay.example.com/relay",
      CODEBUDDY_REMOTE_RELAY_TOKEN: "relay-token",
      CODEBUDDY_REMOTE_RELAY_PAIRING_SECRET: "pair-secret-12345",
      CODEBUDDY_REMOTE_PAIRING_CODE: "PAIR123",
      CODEBUDDY_REMOTE_HISTORY_FILE: "/tmp/custom-history.jsonl",
      CODEBUDDY_REMOTE_DEVICE_STORE_FILE: "/tmp/custom-devices.json",
      CODEBUDDY_REMOTE_AUDIT_FILE: "/tmp/custom-audit.jsonl",
    },
  });

  assert.equal(config.cwd, "/Users/robiluo/aicoding/drink");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 18080);
  assert.equal(config.cliPath, "custom-codebuddy");
  assert.equal(config.token, "fixed-token");
  assert.equal(config.bindToken, "bind-once");
  assert.equal(config.relayUrl, "ws://relay.example.com/relay");
  assert.equal(config.relayToken, "relay-token");
  assert.equal(config.relayPairingSecret, "pair-secret-12345");
  assert.equal(config.pairingCode, "PAIR123");
  assert.equal(config.historyFile, "/tmp/custom-history.jsonl");
  assert.equal(config.deviceStoreFile, "/tmp/custom-devices.json");
  assert.equal(config.auditFile, "/tmp/custom-audit.jsonl");
});

test("codebuddy-remote derives a stable history file from the workspace", () => {
  const config = createRunConfig({
    cwd: "/Users/robiluo/aicoding/drink",
    homeDir: "/Users/robiluo",
    env: {},
  });

  assert.match(
    config.historyFile,
    /^\/Users\/robiluo\/\.codebuddy-remote\/history\/drink-[a-f0-9]{16}\.jsonl$/
  );
  assert.equal(config.deviceStoreFile, "/Users/robiluo/.codebuddy-remote/devices.json");
  assert.match(
    config.auditFile,
    /^\/Users\/robiluo\/\.codebuddy-remote\/audit\/drink-[a-f0-9]{16}\.jsonl$/
  );
});

test("codebuddy-remote configures plain CodeBuddy CLI as an interactive terminal process", () => {
  const options = createAdapterOptions({
    cwd: "/Users/robiluo/aicoding/drink",
    cliPath: "codebuddy",
  });

  assert.deepEqual(options, {
    cwd: "/Users/robiluo/aicoding/drink",
    cliPath: "codebuddy",
    args: [],
  });
});

test("codebuddy-remote help documents relay environment variables", () => {
  const help = formatHelp();

  assert.match(help, /Usage: codebuddy-remote/);
  assert.match(help, /CODEBUDDY_REMOTE_RELAY_URL/);
  assert.match(help, /CODEBUDDY_REMOTE_PAIRING_CODE/);
});

test("codebuddy-remote generates a token when one is not provided", () => {
  const config = createRunConfig({
    cwd: "/tmp/project",
    env: {},
  });

  assert.match(config.token, /^[a-zA-Z0-9_-]{32,}$/);
});

test("pairing URL requires a relay URL", () => {
  assert.throws(
    () => buildPairingPayload({
      config: {
        cwd: "/Users/robiluo/aicoding/drink",
        token: "local-token",
        bindToken: "bind-once",
        relayUrl: "",
        relayToken: "",
        relayPairingSecret: "pair-secret-12345",
        pairingCode: "PAIR123",
      },
      urls: [
        "http://127.0.0.1:17320",
        "http://192.168.1.23:17320",
      ],
      hostName: "DONGSHUILUO-MB5",
      now: 1000,
      ttlMs: 120000,
    }),
    /CODEBUDDY_REMOTE_RELAY_URL is required/
  );
});

test("pairing URL encodes relay connection details", () => {
  const payload = buildPairingPayload({
    config: {
      cwd: "/Users/robiluo/aicoding/drink",
      token: "local-token",
      relayUrl: "wss://relay.example.com/relay",
      relayToken: "relay-token",
      relayPairingSecret: "pair-secret-12345",
      pairingCode: "PAIR123",
    },
    urls: ["http://192.168.1.23:17320"],
    hostName: "DONGSHUILUO-MB5",
    now: 1000,
    ttlMs: 120000,
  });
  const url = new URL(createPairingUrl(payload));

  assert.equal(url.searchParams.get("mode"), "relay");
  assert.equal(url.searchParams.get("relayURL"), "wss://relay.example.com/relay");
  assert.equal(url.searchParams.get("relayToken"), null);
  assert.equal(url.searchParams.get("pairingCode"), "PAIR123");
  assert.equal(url.searchParams.get("pairingSecret"), "pair-secret-12345");
  assert.equal(url.searchParams.get("workspace"), "drink");
  assert.equal(url.searchParams.get("host"), "DONGSHUILUO-MB5");
  assert.equal(url.searchParams.get("expiresAt"), "121000");
});

test("codebuddy-remote treats a symlinked bin path as the CLI entry", () => {
  const realScript = "/repo/apps/local-host/src/codebuddy-remote.mjs";
  const linkedBin = "/opt/homebrew/bin/codebuddy-remote";

  assert.equal(
    isCliEntry({
      metaUrl: `file://${realScript}`,
      argv1: linkedBin,
      realpathSync: (candidate) => {
        if (candidate === linkedBin) return realScript;
        return candidate;
      },
    }),
    true,
  );
});
