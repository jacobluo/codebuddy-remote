#!/usr/bin/env node
import { createRelayServer } from "./relay.mjs";

const host = process.env.CODEBUDDY_RELAY_HOST || "0.0.0.0";
const port = Number(process.env.CODEBUDDY_RELAY_PORT || 17330);
const token = process.env.CODEBUDDY_RELAY_TOKEN || "";

const relay = createRelayServer({ token });
const server = await relay.listen(port, host);
const address = server.address();

console.log("");
console.log("  CodeBuddy Remote Relay");
console.log("");
console.log(`  Relay URL  ws://${host}:${address.port}/relay`);
console.log(`  Health     http://${host}:${address.port}/health`);
console.log(`  Auth       ${token ? "enabled" : "disabled"}`);
console.log("");
console.log("  Press Ctrl+C to stop");
console.log("");

async function shutdown(signal) {
  console.log(`[codebuddy-relay] received ${signal}, shutting down`);
  try {
    await relay.close();
    process.exit(0);
  } catch (error) {
    console.error("[codebuddy-relay] shutdown failed", error);
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
