// Boxed input editor (raw mode, Claude-Code-style). Renders a rounded box
// around the prompt and edits a single logical line (auto-wrapped). Resolves
// the submitted string, or the EXIT sentinel on Ctrl+C / Ctrl+D-on-empty.

import readline from "node:readline";
import { R, GRAY, BLUE, cols, up, down } from "./ansi.mjs";

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
    let lastRows = 0;             // total rows the box occupies (top+body+bottom+hint)
    let firstRender = true;
    let histIdx = history.length; // == length means "current draft"
    let stash = "";

    const innerW = () => Math.max(8, cols() - 4); // fill the terminal width

    // Lay PROMPT + buf (which may contain explicit "\n") into visual rows of
    // width w, and locate the cursor within that grid.
    function layout(w) {
      const rows = [""];
      let r = 0, c = 0, curRow = 0, curCol = 0;
      const put = (ch) => { if (c >= w) { rows.push(""); r++; c = 0; } rows[r] += ch; c++; };
      for (const ch of PROMPT) put(ch);
      for (let k = 0; k <= buf.length; k++) {
        if (k === cursor) { curRow = r; curCol = c; }
        if (k === buf.length) break;
        if (buf[k] === "\n") { rows.push(""); r++; c = 0; } else put(buf[k]);
      }
      if (curCol >= w) { curRow++; curCol = 0; }  // cursor at a wrap boundary
      if (curRow >= rows.length) rows.push("");   // cursor on a fresh trailing row
      return { rows, curRow, curCol };
    }

    function render() {
      const w = innerW();
      const { rows, curRow, curCol } = layout(w);

      if (!firstRender) { out(up(lastTop)); out("\r\x1b[0J"); }
      else { out("\r"); firstRender = false; }

      const top = `${GRAY}╭${"─".repeat(w + 2)}╮${R}`;
      const bot = `${GRAY}╰${"─".repeat(w + 2)}╯${R}`;
      const body = rows.map((ln, i) => {
        const txt = i === 0
          ? `${BLUE}${ln.slice(0, PROMPT.length)}${R}${ln.slice(PROMPT.length)}`
          : ln;
        const pad = " ".repeat(Math.max(0, w - ln.length));
        return `${GRAY}│${R} ${txt}${pad} ${GRAY}│${R}`;
      });
      const hint = `  ${GRAY}↵ send  ·  ⇧↵ newline  ·  / for commands  ·  exit${R}`;
      out([top, ...body, bot, hint].join("\n"));

      lastRows = rows.length + 3; // top + rows + bottom + hint
      out(up(lastRows - 1 - (1 + curRow))); // park on the cursor's content row
      out(`\x1b[${3 + curCol}G`);            // col 1:'│' 2:' ' 3:text
      lastTop = 1 + curRow;
    }

    function setBuf(next, cur) {
      buf = next;
      cursor = cur === undefined ? next.length : Math.max(0, Math.min(cur, next.length));
    }

    function insertNewline() {
      setBuf(buf.slice(0, cursor) + "\n" + buf.slice(cursor), cursor + 1);
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
      render(); // ensure the box reflects the final text (e.g. paste-then-Enter)
      // Keep the box on screen (with the typed text inside) and move the cursor
      // onto a fresh line below it, so it stays as scrollback after submit.
      out(down((lastRows - 1) - lastTop)); // parked row → hint line (the last box row)
      out("\r\n");
      resolve(value);
    }

    function onData(chunk) {
      let s = chunk.toString("utf8")
        .replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, ""); // strip bracketed-paste markers

      let i = 0;
      while (i < s.length) {
        const ch = s[i];

        if (ch === "\x1b") { // escape sequence (arrows, home/end, delete, modified Enter)
          const nxt = s[i + 1];
          if (nxt === "\r" || nxt === "\n") { insertNewline(); i += 2; continue; } // Alt/Option+Enter
          const rest = s.slice(i);
          const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/) || rest.match(/^\x1bO([A-Z])/);
          if (m) {
            // Shift+Enter — kitty (CSI 13;2u) or modifyOtherKeys (CSI 27;2;13~)
            if (m[0] === "\x1b[13;2u" || m[0] === "\x1b[27;2;13~") { insertNewline(); i += m[0].length; continue; }
            const code = m[2] ?? m[1];
            if (code === "D") cursor = Math.max(0, cursor - 1);
            else if (code === "C") cursor = Math.min(buf.length, cursor + 1);
            // ↑/↓ browse history only for a single-line draft, so they don't clobber a multi-line one
            else if ((code === "A" || code === "B") && !buf.includes("\n")) browseHistory(code === "A" ? -1 : 1);
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
        if (ch === "\r" || ch === "\n") { done(buf); return; } // plain Enter submits
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
