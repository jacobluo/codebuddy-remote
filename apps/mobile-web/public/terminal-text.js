const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BARE_CSI_PATTERN = /\[(?:\??\d+(?:;\d+)*)[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function normalizeTerminalOutput(text = "") {
  return String(text)
    .replace(OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(BARE_CSI_PATTERN, "")
    .replace(/\r/g, "\n")
    .replace(CONTROL_PATTERN, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .filter((line, index, lines) => line.trim() || lines[index - 1]?.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function terminalOutputLabel(text = "") {
  return normalizeTerminalOutput(text);
}

export class TerminalScreen {
  constructor({ maxLines = 160 } = {}) {
    this.maxLines = maxLines;
    this.lines = [""];
    this.row = 0;
    this.col = 0;
  }

  write(chunk = "") {
    const text = String(chunk).replace(OSC_PATTERN, "");

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (char === "\x1b" && text[index + 1] === "[") {
        const parsed = parseCsi(text, index + 2);
        if (parsed) {
          this.#applyCsi(parsed);
          index = parsed.end;
          continue;
        }
      }

      if (char === "\r") {
        this.col = 0;
        continue;
      }

      if (char === "\n") {
        this.row += 1;
        this.col = 0;
        this.#ensureLine();
        this.#trimScrollback();
        continue;
      }

      if (CONTROL_PATTERN.test(char)) continue;
      CONTROL_PATTERN.lastIndex = 0;
      this.#put(char);
    }
  }

  toString() {
    return this.lines
      .map((line) => normalizeTerminalOutput(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
  }

  #put(char) {
    this.#ensureLine();
    const line = this.lines[this.row] || "";
    const padded = line.padEnd(this.col, " ");
    this.lines[this.row] = `${padded.slice(0, this.col)}${char}${padded.slice(this.col + 1)}`;
    this.col += 1;
  }

  #ensureLine() {
    while (this.lines.length <= this.row) this.lines.push("");
  }

  #trimScrollback() {
    if (this.lines.length <= this.maxLines) return;
    const overflow = this.lines.length - this.maxLines;
    this.lines.splice(0, overflow);
    this.row = Math.max(0, this.row - overflow);
  }

  #applyCsi({ params, command }) {
    const first = Number(params.replace("?", "").split(";")[0] || 0);
    if (command === "A") {
      this.row = Math.max(0, this.row - (first || 1));
      this.#ensureLine();
      return;
    }
    if (command === "B") {
      this.row += first || 1;
      this.#ensureLine();
      return;
    }
    if (command === "G") {
      this.col = Math.max(0, (first || 1) - 1);
      return;
    }
    if (command === "H" || command === "f") {
      const [row = "1", col = "1"] = params.split(";");
      this.row = Math.max(0, Number(row || 1) - 1);
      this.col = Math.max(0, Number(col || 1) - 1);
      this.#ensureLine();
      return;
    }
    if (command === "K") {
      this.#ensureLine();
      if (first === 1) this.lines[this.row] = this.lines[this.row].slice(this.col);
      else if (first === 2) this.lines[this.row] = "";
      else this.lines[this.row] = this.lines[this.row].slice(0, this.col);
      return;
    }
    if (command === "J" && (first === 2 || first === 3)) {
      this.lines = [""];
      this.row = 0;
      this.col = 0;
    }
  }
}

function parseCsi(text, start) {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        params: text.slice(start, index).replace(/[ -/]/g, ""),
        command: text[index],
        end: index,
      };
    }
    index += 1;
  }
  return null;
}
