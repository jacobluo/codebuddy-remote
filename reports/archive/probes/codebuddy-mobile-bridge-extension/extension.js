const http = require("node:http");
const vscode = require("vscode");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CODEBUDDY_PROBE_PORT || 17321);

const CANDIDATE_COMMANDS = [
  "tencentcloud.codingcopilot.getWebviewInfo",
  "tencentcloud.codingcopilot.chat.startNewChat",
  "tencentcloud.codingcopilot.chat.sendMessage",
  "tencentcloud.codingcopilot.addToChat",
  "tencentcloud.codingcopilot.sendToChat",
  "tencentcloud.codingcopilot.ide.addToChat",
  "tencentcloud.codingcopilot.clearSession",
  "tencentcloud.codingcopilot.checkChatRunning",
  "tencentcloud.codingcopilot.isAgentBusy",
  "tencentcloud.codingcopilot.getContext",
  "codebuddy.session.upsert",
  "codebuddy.session.commitNewSession",
  "workbench.action.forceResolveWebviewView",
  "workbench.action.openCodeBuddyWebview",
  "workbench.view.extension.coding-copilot-chat",
];

let server;
let lastProbe;

async function runProbe() {
  const allCommands = await vscode.commands.getCommands(true);
  const visibleCandidates = CANDIDATE_COMMANDS.filter((command) =>
    allCommands.includes(command)
  );
  const results = [];

  for (const command of visibleCandidates) {
    try {
      let value;
      if (command === "workbench.action.forceResolveWebviewView") {
        value = await vscode.commands.executeCommand(
          command,
          "coding-copilot.webviews.chat"
        );
      } else {
        value = await vscode.commands.executeCommand(command);
      }
      results.push({
        command,
        ok: true,
        resultType: typeof value,
        result: serialize(value),
      });
    } catch (error) {
      results.push({
        command,
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
    }
  }

  lastProbe = {
    at: new Date().toISOString(),
    extensionHost: vscode.env.appName,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((folder) =>
      folder.uri.toString()
    ),
    commandCount: allCommands.length,
    visibleCandidates,
    results,
  };

  return lastProbe;
}

async function listCommands(filter) {
  const commands = await vscode.commands.getCommands(true);
  const normalized = filter ? String(filter).toLowerCase() : "";
  return commands
    .filter((command) =>
      normalized ? command.toLowerCase().includes(normalized) : true
    )
    .sort();
}

async function executeCommand(command, args = []) {
  const value = await vscode.commands.executeCommand(command, ...args);
  return {
    command,
    ok: true,
    resultType: typeof value,
    result: serialize(value),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

function serialize(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function startServer(context) {
  if (server) return;

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      if (req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          appName: vscode.env.appName,
          port: PORT,
          lastProbe,
        });
        return;
      }

      if (url.pathname === "/probe") {
        sendJson(res, 200, await runProbe());
        return;
      }

      if (url.pathname === "/commands") {
        const filter = url.searchParams.get("filter") || "";
        sendJson(res, 200, {
          filter,
          commands: await listCommands(filter),
        });
        return;
      }

      if (url.pathname === "/exec") {
        let payload = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          payload = raw ? JSON.parse(raw) : {};
        } else {
          payload = {
            command: url.searchParams.get("command"),
            args: JSON.parse(url.searchParams.get("args") || "[]"),
          };
        }
        if (!payload.command) {
          sendJson(res, 400, { ok: false, error: "missing command" });
          return;
        }
        sendJson(
          res,
          200,
          await executeCommand(payload.command, payload.args || [])
        );
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[codebuddy-mobile-probe] listening on http://${HOST}:${PORT}`);
  });

  context.subscriptions.push({
    dispose() {
      server.close();
      server = undefined;
    },
  });
}

async function activate(context) {
  startServer(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("codebuddyMobileProbe.run", async () => {
      const result = await runProbe();
      void vscode.window.showInformationMessage(
        `CodeBuddy Mobile Probe: ${result.visibleCandidates.length} candidate commands visible`
      );
      return result;
    })
  );
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
