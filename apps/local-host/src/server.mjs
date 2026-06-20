import { createLocalHost } from "./local-host.mjs";
import { MockCliAdapter } from "./mock-cli-adapter.mjs";
import { RealCliAdapter } from "./real-cli-adapter.mjs";
import { ServeCliAdapter } from "./serve-cli-adapter.mjs";

const port = Number(process.env.CODEBUDDY_REMOTE_PORT || 17320);
const token = process.env.CODEBUDDY_REMOTE_TOKEN || "dev-token";
const adapterName = process.env.CODEBUDDY_REMOTE_ADAPTER || "mock";

const host = createLocalHost({
  adapter: createAdapter(adapterName),
  token,
});

const server = await host.listen(port);
const address = server.address();

console.log(
  `[codebuddy-remote] local host listening on http://127.0.0.1:${address.port}`
);
console.log(`[codebuddy-remote] adapter: ${adapterName}`);
console.log(`[codebuddy-remote] dev token: ${token}`);

function createAdapter(name) {
  if (name === "serve") return new ServeCliAdapter({ cwd: process.cwd() });
  if (name === "real") return new RealCliAdapter({ cwd: process.cwd() });
  return new MockCliAdapter();
}

async function shutdown(signal) {
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
