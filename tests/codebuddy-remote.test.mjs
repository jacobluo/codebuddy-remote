import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildStartupUrls,
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
    env: {
      CODEBUDDY_REMOTE_HOST: "127.0.0.1",
      CODEBUDDY_REMOTE_PORT: "18080",
      CODEBUDDY_CLI_PATH: "custom-codebuddy",
      CODEBUDDY_REMOTE_TOKEN: "fixed-token",
      CODEBUDDY_REMOTE_RELAY_URL: "ws://relay.example.com/relay",
      CODEBUDDY_REMOTE_RELAY_TOKEN: "relay-token",
      CODEBUDDY_REMOTE_PAIRING_CODE: "PAIR123",
    },
  });

  assert.equal(config.cwd, "/Users/robiluo/aicoding/drink");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 18080);
  assert.equal(config.cliPath, "custom-codebuddy");
  assert.equal(config.token, "fixed-token");
  assert.equal(config.relayUrl, "ws://relay.example.com/relay");
  assert.equal(config.relayToken, "relay-token");
  assert.equal(config.pairingCode, "PAIR123");
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

test("startup URLs include local API candidates", () => {
  const urls = buildStartupUrls({
    port: 17320,
    host: "0.0.0.0",
    interfaces: {
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      en0: [{ family: "IPv4", address: "192.168.1.23", internal: false }],
    },
  });

  assert.deepEqual(urls, [
    "http://127.0.0.1:17320",
    "http://192.168.1.23:17320",
  ]);
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
