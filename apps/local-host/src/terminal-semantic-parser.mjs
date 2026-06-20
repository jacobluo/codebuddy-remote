const TOOL_CALL_RE = /^●\s+(?:(?<phase>[A-Za-z][A-Za-z0-9_-]*)\s+·\s+)?(?<toolName>[A-Za-z][A-Za-z0-9_-]*)\((?<args>.*)\)$/;
const TOOL_OUTPUT_RE = /^[⎿└]\s*(.*)$/;
const DIFF_RE = /([+-]?\d+)\s+additions?\s+([-+]?\d+)?\s*-?\s*(\d+)?\s*deletions?/i;

export class TerminalSemanticParser {
  #seen = new Set();
  #lastTool = null;
  #inAssistant = false;

  write(chunk) {
    const text = cleanTerminalText(String(chunk || ""));
    const events = [];

    for (const rawLine of text.split(/\r?\n/)) {
      const line = normalizeLine(rawLine);
      if (!line) continue;

      const plan = parsePlan(line);
      if (plan) {
        this.#push(events, plan);
        continue;
      }

      const permissionEvents = parsePermission(line, this.#lastTool);
      if (permissionEvents.length) {
        for (const permissionEvent of permissionEvents) {
          this.#push(events, permissionEvent);
        }
        continue;
      }

      const toolOutput = parseToolOutput(line, this.#lastTool);
      if (toolOutput) {
        this.#inAssistant = false;
        const diff = parseDiffFromOutput(toolOutput, this.#lastTool);
        if (diff) {
          this.#push(events, diff);
        } else {
          this.#push(events, toolOutput);
        }
        continue;
      }

      const tool = parseToolCall(line);
      if (tool) {
        this.#inAssistant = false;
        this.#lastTool = tool.context;
        this.#push(events, tool.event);
        continue;
      }

      const assistant = parseAssistant(line);
      if (assistant) {
        this.#lastTool = null;
        this.#inAssistant = true;
        this.#push(events, assistant);
        continue;
      }

      const continuation = parseAssistantContinuation(line, {
        inAssistant: this.#inAssistant,
        lastTool: this.#lastTool,
      });
      if (continuation) {
        this.#push(events, continuation);
      }
    }

    return events;
  }

  #push(events, event) {
    const key = semanticKey(event);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    events.push(event);
  }
}

function parseAssistant(line) {
  if (!line.startsWith("● ")) return null;
  const text = stripInlineNoise(stripAssistantPhase(line.slice(2).trim()));
  if (!text || TOOL_CALL_RE.test(line)) return null;
  if (isNoise(text)) return null;
  return {
    name: "assistant.delta",
    payload: {
      kind: "assistant",
      title: "Assistant",
      text,
      status: "completed",
    },
  };
}

function parseAssistantContinuation(line, { inAssistant, lastTool }) {
  if (!inAssistant) return null;
  if (lastTool) return null;
  if (isNoise(line) || isMenuOption(line) || isBoxDrawing(line)) return null;
  if (/^(Bash command|Do you want to proceed\?)$/i.test(line)) return null;
  return {
    name: "assistant.delta",
    payload: {
      kind: "assistant",
      title: "Assistant",
      text: stripInlineNoise(line),
      status: "completed",
    },
  };
}

function parseToolCall(line) {
  const match = line.match(TOOL_CALL_RE);
  if (!match) return null;

  const { phase = "", toolName, args: rawArgs } = match.groups;
  const args = rawArgs.trim();
  const title = titleForTool(toolName, args);
  const kind = kindForTool(toolName, args);
  const context = {
    phase,
    toolName,
    args,
    kind,
    title,
    command: toolName === "Bash" ? args : "",
    target: targetForTool(toolName, args),
  };

  return {
    context,
    event: {
      name: "tool.requested",
      payload: {
        kind,
        title,
        phase,
        toolName,
        command: context.command,
        target: context.target,
        text: args,
        status: "running",
      },
    },
  };
}

function parseToolOutput(line, lastTool) {
  const match = line.match(TOOL_OUTPUT_RE);
  if (!match || !lastTool) return null;
  const text = match[1].trim();
  if (!text) return null;
  if (isNoise(text)) return null;

  const kind = outputKind(lastTool, text);
  return {
    name: "tool.output",
    payload: {
      kind,
      title: outputTitle(kind, text),
      toolName: lastTool.toolName,
      command: lastTool.command,
      target: kind === "artifact" ? extractArtifactTarget(text) : lastTool.target,
      text,
      status: statusFromOutput(text),
    },
  };
}

function parseDiffFromOutput(outputEvent, lastTool) {
  if (!lastTool) return null;
  const text = outputEvent.payload.text || "";
  const match = text.match(DIFF_RE);
  if (!match && lastTool.kind !== "edit") return null;

  const additions = match ? Math.abs(Number(match[1])) : 0;
  const deletions = match ? Math.abs(Number(match[2] || match[3] || 0)) : 0;
  return {
    name: "diff.created",
    payload: {
      kind: "diff",
      title: lastTool.target || "代码变更",
      toolName: lastTool.toolName,
      target: lastTool.target,
      additions,
      deletions,
      text,
      status: "changed",
    },
  };
}

function parsePermission(line, lastTool) {
  if (!/waiting for permission|permission|approve|do you want to proceed/i.test(line)) return [];
  const asksToProceed = /do you want to proceed/i.test(line);
  const stateEvent = {
    name: "session.state",
    payload: {
      kind: "status",
      title: "waiting_permission",
      status: "waiting_permission",
      text: line,
    },
  };
  if (!asksToProceed) return [stateEvent];

  const title = asksToProceed && lastTool?.title ? `需要确认：${lastTool.title}` : "等待权限";
  return [
    {
      name: "tool.permissionRequested",
      payload: {
        kind: "permission",
        title,
        toolName: lastTool?.toolName || "",
        command: lastTool?.command || "",
        target: lastTool?.target || "",
        text: line,
        status: "waiting",
      },
    },
    stateEvent,
  ];
}

function cleanTerminalText(text) {
  return text
    .replace(/\u001B\][\s\S]*?(\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u0007/g, "");
}

function normalizeLine(line) {
  return line
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isNoise(text) {
  if (text.startsWith("Tip:")) return true;
  if (text.includes("Waking…")) return true;
  if (text.includes("Sweeping…")) return true;
  if (text.includes("esc to interrupt")) return true;
  if (text.includes("Press Shift+Tab")) return true;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+/.test(text)) return true;
  if (/\bExplore · .*\b(processing|running|waiting for permission)\b/i.test(text)) return true;
  if (text === "? for shortcuts") return true;
  if (/^\(?\d+s\s+·/.test(text)) return true;
  if (/^>($|\s+)/.test(text)) return true;
  return false;
}

function stripAssistantPhase(text) {
  return text.replace(/^[A-Za-z][A-Za-z0-9_-]*\s+·\s+/, "");
}

function stripInlineNoise(text) {
  return text
    .replace(/\s*[⎿└]\s*Tip:.*$/i, "")
    .replace(/\s*Press Shift\+Tab.*$/i, "")
    .trim();
}

function isMenuOption(text) {
  return /^>?\s*\d+\.\s+/.test(text);
}

function isBoxDrawing(text) {
  return /^[─━╭╮╰╯│┌┐└┘├┤┬┴┼\s]+$/.test(text);
}

function titleForTool(toolName, args) {
  if (toolName === "Bash") return args || "Shell command";
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return targetForTool(toolName, args) || toolName;
  }
  return toolName;
}

function kindForTool(toolName, args) {
  if (toolName === "Bash") return "command";
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") return "edit";
  if (toolName === "Read" || toolName === "Search" || toolName === "Glob") return "tool";
  return "tool";
}

function targetForTool(toolName, args) {
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    return args.split(",")[0]?.trim() || "";
  }
  const pathMatch = args.match(/path:\s*"([^"]+)"/);
  if (pathMatch) return pathMatch[1];
  return "";
}

function outputKind(lastTool, text) {
  if (isArtifactOutput(text)) return "artifact";
  if (lastTool.kind === "test" || isTestOutput(text)) return "test";
  if (lastTool.kind === "command") return "command";
  if (lastTool.kind === "edit") return "edit";
  return "tool";
}

function outputTitle(kind, text) {
  if (kind === "artifact") return "截图";
  if (kind === "test") return text;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function statusFromOutput(text) {
  if (/fail|error|✖/i.test(text)) return "failed";
  if (/pass|passed|succeeded|success|✔/i.test(text)) return "passed";
  return "completed";
}

function isTestCommand(command) {
  return /\b(test|lint|typecheck|xcodebuild|swift test|npm test|pnpm test|yarn test)\b/i.test(command);
}

function isTestOutput(text) {
  return /\b(tests?|pass|passed|fail|failed|build succeeded|build failed)\b/i.test(text);
}

function parsePlan(line) {
  if (!/^[-*]\s+\[[ xX]\]/.test(line)) return null;
  return {
    name: "tool.output",
    payload: {
      kind: "plan",
      title: "计划",
      text: line.replace(/^[-*]\s+\[[ xX]\]\s*/, ""),
      status: /\[[xX]\]/.test(line) ? "completed" : "running",
    },
  };
}

function isArtifactOutput(text) {
  return /screenshot|image|artifact|saved to|wrote .* to/i.test(text) &&
    /(?:\/|file:).+\.(png|jpg|jpeg|gif|pdf|html|json|txt|md)\b/i.test(text);
}

function extractArtifactTarget(text) {
  const match = text.match(/((?:\/|file:)[^\s]+\.(?:png|jpg|jpeg|gif|pdf|html|json|txt|md))/i);
  return match?.[1] || "";
}

function semanticKey(event) {
  const payload = event.payload || {};
  return [
    event.name,
    payload.kind || "",
    payload.toolName || "",
    payload.title || "",
    payload.command || "",
    payload.target || "",
    payload.text || "",
    payload.status || "",
  ].join("\u001F");
}
