#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const reportsDir = path.join(repoRoot, "reports", "archive", "generated");
fs.mkdirSync(reportsDir, { recursive: true });

const candidates = {
  app: [
    "/Applications/CodeBuddy.app/Contents/Resources/app",
    "/Applications/CodeBuddy CN.app/Contents/Resources/app",
  ],
  cliPackage: [
    "/opt/homebrew/lib/node_modules/@tencent-ai/codebuddy-code",
    "/usr/local/lib/node_modules/@tencent-ai/codebuddy-code",
  ],
};

const patterns = [
  "remote-control",
  "RemoteAgentProxy",
  "registerCommand",
  "executeCommand",
  "onDidReceiveMessage",
  "postMessage",
  "webview",
  "sessionId",
  "background session",
  "approval",
  "permission",
  "AskUserQuestion",
  "plan_attempt_completion",
  "execute_command",
  "write_to_file",
  "replace_in_file",
  "mcp_server",
  "terminalChat",
  "getWebviewInfo",
  "codingcopilot.InConversation",
];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function safeReadJson(p) {
  try {
    return readJson(p);
  } catch (error) {
    return { error: String(error) };
  }
}

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function snippet(text, index, size = 220) {
  const start = Math.max(0, index - size);
  const end = Math.min(text.length, index + size);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .replaceAll("\u0000", "")
    .trim();
}

function scanFiles(files) {
  const result = {};
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = file;
    for (const pattern of patterns) {
      let idx = -1;
      let count = 0;
      const samples = [];
      while ((idx = text.indexOf(pattern, idx + 1)) !== -1) {
        count += 1;
        if (samples.length < 3) samples.push(snippet(text, idx));
      }
      if (count) {
        result[pattern] ||= [];
        result[pattern].push({ file: rel, count, samples });
      }
    }
  }
  return result;
}

function extractStringMatches(files, regex, limit = 100) {
  const matches = new Set();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(regex)) {
      matches.add(match[1] ?? match[0]);
      if (matches.size >= limit) return [...matches].sort();
    }
  }
  return [...matches].sort();
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 8000,
    }).trim();
  } catch (error) {
    return {
      error: String(error),
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? "",
    };
  }
}

function summarizePackage(pkg) {
  const contributes = pkg.contributes ?? {};
  return {
    name: pkg.name,
    publisher: pkg.publisher,
    displayName: pkg.displayName,
    version: pkg.version,
    engines: pkg.engines,
    activationEvents: pkg.activationEvents,
    extensionKind: pkg.extensionKind,
    main: pkg.main,
    enabledApiProposals: pkg.enabledApiProposals,
    authentication: contributes.authentication ?? [],
    viewsContainers: contributes.viewsContainers ?? {},
    views: contributes.views ?? {},
    commands: (contributes.commands ?? []).map((c) => ({
      command: c.command,
      title: c.title,
      enablement: c.enablement,
      category: c.category,
    })),
    menus: contributes.menus ? Object.keys(contributes.menus) : [],
    configurationKeys: (contributes.configuration?.properties)
      ? Object.keys(contributes.configuration.properties)
      : [],
  };
}

function appProbe(appRoot) {
  const genieRoot = path.join(appRoot, "extensions/genie");
  const packagePath = path.join(genieRoot, "package.json");
  const productPaths = [
    path.join(appRoot, "product.json"),
    path.join(appRoot, "product-ide.json"),
    path.join(appRoot, "product-ide-cn.json"),
    path.join(genieRoot, "product.json"),
  ];
  const bundleFiles = [
    ...walk(path.join(genieRoot, "out/extension")).filter((p) => p.endsWith(".js")),
    ...walk(path.join(genieRoot, "out/webviews")).filter((p) => p.endsWith(".js")),
  ];
  const pkg = exists(packagePath) ? readJson(packagePath) : null;
  return {
    appRoot,
    exists: exists(appRoot),
    genieRoot,
    package: pkg ? summarizePackage(pkg) : null,
    productFiles: Object.fromEntries(
      productPaths
        .filter(exists)
        .map((p) => [p, safeReadJson(p)])
    ),
    bundleFileCount: bundleFiles.length,
    scan: scanFiles(bundleFiles),
    commandLikeStrings: extractStringMatches(
      bundleFiles,
      /["'`]((?:tencentcloud|codingcopilot|codebuddy|workbench|vscode)\.[A-Za-z0-9_.:-]+)["'`]/g,
      160
    ),
    webviewMessageLikeStrings: extractStringMatches(
      bundleFiles,
      /["'`]([A-Za-z0-9_.:-]*(?:message|Message|session|Session|approval|Approval|permission|Permission|conversation|Conversation)[A-Za-z0-9_.:-]*)["'`]/g,
      180
    ),
  };
}

const appRoots = candidates.app.filter(exists);
const cliPackageRoot = candidates.cliPackage.find(exists);
const cliPkg = cliPackageRoot ? safeReadJson(path.join(cliPackageRoot, "package.json")) : null;
const codebuddyHelp = run("codebuddy", ["--help"]);
const buddyHelp = run("/Users/robiluo/.codebuddy/bin/buddy", ["--help"]);

const report = {
  generatedAt: new Date().toISOString(),
  appRoots,
  apps: appRoots.map(appProbe),
  cli: {
    packageRoot: cliPackageRoot ?? null,
    package: cliPkg,
    codebuddyHelp,
    buddyHelp,
  },
};

const jsonPath = path.join(reportsDir, "codebuddy-ide-probe.json");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

function countPattern(app, pattern) {
  return (app.scan[pattern] ?? []).reduce((sum, item) => sum + item.count, 0);
}

function mdList(items) {
  return items.length ? items.map((x) => `- ${x}`).join("\n") : "- 未发现";
}

const firstApp = report.apps[0];
const commandList = firstApp?.package?.commands?.map((c) => c.command) ?? [];
const scanRows = patterns
  .map((p) => `| \`${p}\` | ${firstApp ? countPattern(firstApp, p) : 0} |`)
  .join("\n");

const md = `# CodeBuddy IDE Mobile Control Feasibility Probe

Generated: ${report.generatedAt}

## Local Installation

- App roots: ${report.appRoots.join(", ") || "not found"}
- Genie package: ${firstApp?.package?.name ?? "not found"} ${firstApp?.package?.version ?? ""}
- Genie main: ${firstApp?.package?.main ?? "n/a"}
- Genie extensionKind: ${JSON.stringify(firstApp?.package?.extensionKind ?? [])}
- Genie activationEvents: ${JSON.stringify(firstApp?.package?.activationEvents ?? [])}
- CLI package: ${report.cli.packageRoot ?? "not found"}
- CLI package version: ${report.cli.package?.version ?? "n/a"}

## Public IDE Extension Surface

Views:

\`\`\`json
${JSON.stringify(firstApp?.package?.views ?? {}, null, 2)}
\`\`\`

Commands contributed by Genie:

${mdList(commandList.map((c) => `\`${c}\``))}

Enabled VS Code proposed APIs:

${mdList((firstApp?.package?.enabledApiProposals ?? []).map((p) => `\`${p}\``))}

## Static Bundle Signals

| Pattern | Matches |
| --- | ---: |
${scanRows}

Command-like strings sampled from bundles:

${mdList((firstApp?.commandLikeStrings ?? []).slice(0, 80).map((s) => `\`${s}\``))}

Message/session-like strings sampled from bundles:

${mdList((firstApp?.webviewMessageLikeStrings ?? []).slice(0, 80).map((s) => `\`${s}\``))}

## Initial Interpretation

- CodeBuddy IDE is VS Code/Electron-derived and ships a built-in Genie extension. This makes an auxiliary extension-based bridge technically plausible.
- The built-in Genie extension contributes a CodeBuddy webview and internal commands. Static scanning can identify candidate commands and webview message paths, but cannot prove they accept prompt injection without runtime testing.
- The CodeBuddy Code CLI exposes session-oriented and server-oriented flags in \`--help\`, including \`--session-id\`, \`--continue\`, \`--resume\`, \`daemon\`, \`attach\`, \`--serve\`, and \`--remote-control\`. That is the strongest route for a phone controller when the local process remains session owner.
- A true “phone controls existing IDE session” feature still needs one of these verified bridges: official local API from the active IDE agent, callable extension commands that can submit user prompts/approvals, or a product-level change inside CodeBuddy.
`;

const mdPath = path.join(reportsDir, "codebuddy-ide-feasibility.md");
fs.writeFileSync(mdPath, md);

console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
