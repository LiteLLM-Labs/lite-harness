// Boxed input editor (raw mode, Claude-Code-style). Renders a rounded box
// around the prompt and edits a single logical line (auto-wrapped). Resolves
// the submitted string, or the EXIT sentinel on Ctrl+C / Ctrl+D-on-empty.

import readline from "node:readline";
import { R, GRAY, BLUE, cols, up } from "./ansi.mjs";

export const EXIT = Symbol("exit");

export function boxedPrompt(history) {
  const stdin = process.stdin;

  // Non-TTY (piped / test) — fall back to a plain readline prompt.
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      let answered = false;
      rl.on("close", () => { if (!answered) resolve(EXIT); });
      rl.question(`${BLUE}❯${R} `, (line) => { answered = true; rl.close(); resolve(line); });
    });
  }

  return new Promise((resolve) => {
    const out = (s) => process.stdout.write(s);
    const PROMPT = "❯ ";
    let buf = "";
    let cursor = 0;               // index into buf
    let lastTop = 0;              // lines from parked cursor up to the top border
    let firstRender = true;
    let histIdx = history.length; // == length means "current draft"
    let stash = "";

    const innerW = () => Math.max(8, cols() - 4); // fill the terminal width

    function wrap(s, w) {
      const lines = [];
      for (let i = 0; i < s.length; i += w) lines.push(s.slice(i, i + w));
      return lines.length ? lines : [""];
    }

    function render() {
      const w = innerW();
      const combined = PROMPT + buf;
      const lines = wrap(combined, w);
      const pos = PROMPT.length + cursor;
      let curRow = Math.floor(pos / w);
      let curCol = pos % w;
      if (curRow >= lines.length) lines.push(""); // cursor sits past wrapped text

      if (!firstRender) { out(up(lastTop)); out("\r\x1b[0J"); }
      else { out("\r"); firstRender = false; }

      const top  = `${GRAY}╭${"─".repeat(w + 2)}╮${R}`;
      const bot  = `${GRAY}╰${"─".repeat(w + 2)}╯${R}`;
      const body = lines.map((ln, i) => {
        const txt = i === 0
          ? `${BLUE}${ln.slice(0, PROMPT.length)}${R}${ln.slice(PROMPT.length)}`
          : ln;
        const pad = " ".repeat(Math.max(0, w - ln.length));
        return `${GRAY}│${R} ${txt}${pad} ${GRAY}│${R}`;
      });
      const hint = `  ${GRAY}↵ send  ·  / for commands  ·  exit${R}`;
      out([top, ...body, bot, hint].join("\n"));

      const totalRows = lines.length + 3; // top + body + bottom + hint
      out(up(totalRows - 1 - (1 + curRow)));        // park on the cursor's content row
      out(`\x1b[${3 + curCol}G`);                   // col 1:'│' 2:' ' 3:text
      lastTop = 1 + curRow;
    }

    function setBuf(next, cur) {
      buf = next;
      cursor = cur === undefined ? next.length : Math.max(0, Math.min(cur, next.length));
    }

    function browseHistory(dir) {
      if (!history.length) return;
      if (histIdx === history.length) stash = buf;
      const next = histIdx + dir;
      if (next < 0 || next > history.length) return;
      histIdx = next;
      setBuf(histIdx === history.length ? stash : history[histIdx]);
    }

    function done(value) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      out(up(lastTop)); out("\r\x1b[0J"); // wipe the box, leave cursor at its top-left
      resolve(value);
    }

    function onData(chunk) {
      let s = chunk.toString("utf8")
        .replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, ""); // strip bracketed-paste markers

      let i = 0;
      while (i < s.length) {
        const ch = s[i];

        if (ch === "\x1b") { // escape sequence (arrows, home/end, delete)
          const rest = s.slice(i);
          const m = rest.match(/^\x1b\[([0-9;]*)([A-Z~HF])/) || rest.match(/^\x1bO([A-Z])/);
          if (m) {
            const code = m[2] ?? m[1];
            if (code === "D") cursor = Math.max(0, cursor - 1);
            else if (code === "C") cursor = Math.min(buf.length, cursor + 1);
            else if (code === "A" || code === "B") browseHistory(code === "A" ? -1 : 1);
            else if (code === "H") cursor = 0;
            else if (code === "F") cursor = buf.length;
            else if (m[1] === "3" && code === "~") setBuf(buf.slice(0, cursor) + buf.slice(cursor + 1), cursor);
            i += m[0].length;
            continue;
          }
          i += 1; // lone ESC
          continue;
        }

        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") { done(buf); return; }
        if (code === 3) { done(EXIT); return; }                              // Ctrl+C
        if (code === 4) { if (!buf) { done(EXIT); return; } i++; continue; } // Ctrl+D
        if (code === 1) { cursor = 0; i++; continue; }                       // Ctrl+A
        if (code === 5) { cursor = buf.length; i++; continue; }              // Ctrl+E
        if (code === 21) { setBuf(buf.slice(cursor), 0); i++; continue; }    // Ctrl+U
        if (code === 23) {                                                   // Ctrl+W
          const left = buf.slice(0, cursor).replace(/\s*\S+\s*$/, "");
          setBuf(left + buf.slice(cursor), left.length); i++; continue;
        }
        if (code === 127 || code === 8) {                                    // Backspace
          if (cursor > 0) setBuf(buf.slice(0, cursor - 1) + buf.slice(cursor), cursor - 1);
          i++; continue;
        }
        if (code < 32) { i++; continue; }                                    // other controls

        // Printable run (handles paste). Newlines collapse to spaces.
        let j = i, ins = "";
        while (j < s.length && s[j] !== "\x1b") {
          const c = s[j], cc = c.charCodeAt(0);
          if (c === "\r" || c === "\n") { ins += " "; j++; continue; }
          if (cc < 32) break;
          ins += c; j++;
        }
        if (ins) setBuf(buf.slice(0, cursor) + ins + buf.slice(cursor), cursor + ins.length);
        i = j;
      }
      render();
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    render();
  });
}
