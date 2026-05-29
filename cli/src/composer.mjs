// Persistent, bottom-pinned input box (Claude-Code-style).
//
// The conversation scrolls inside a terminal scroll region (DECSTBM) while the
// input box is drawn in the rows below that region — so the box is ALWAYS
// visible at the bottom and never scrolls away or gets recreated per turn.
//
// Cursor model: the terminal cursor lives in the scroll region (the
// "conversation cursor") and output just flows through it — no per-write
// juggling. We only save/restore (DECSC `ESC 7` / DECRC `ESC 8`) the
// conversation cursor at the boundaries where we paint the box, because
// painting moves the cursor into the box.

import readline from "node:readline";
import { R, GRAY, BLUE, cols } from "./ansi.mjs";

const rows = () => process.stdout.rows || 24;
const PROMPT = "❯ ";
const HINT = `  ${GRAY}↵ send  ·  ⇧↵ newline  ·  / for commands  ·  exit${R}`;

// onSubmit(text) is awaited; the composer stays "busy" until idle() is called.
// onInterrupt()/onQuit() fire on Esc / Ctrl+C.
export function createComposer({ onSubmit, onInterrupt, onQuit }) {
  const out = (s) => process.stdout.write(s);
  const tty = process.stdin.isTTY && process.stdout.isTTY;

  // ── Non-TTY fallback (piped / tests): plain readline, direct printing ──────
  if (!tty) {
    function ask() {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${BLUE}❯${R} `, async (line) => {
        rl.close();
        const t = (line ?? "").trim();
        if (t === "exit" || t === "quit" || t === "\\q") return onQuit();
        out(`  ${BLUE}❯${R} ${t}\n`);
        await onSubmit(t);
      });
      rl.on("close", () => {});
    }
    return {
      start() {}, print: (s) => out(s), idle: ask,
      suspend() {}, resume() {}, clearConversation() {}, stop() {},
    };
  }

  // ── TTY: pinned box ────────────────────────────────────────────────────────
  let buf = "", cursor = 0;
  const history = []; let histIdx = 0, stash = "";
  let reserved = 0;   // rows reserved at the bottom for the box
  let busy = true;    // not accepting edits until idle()
  let listening = false;

  const innerW = () => Math.max(8, cols() - 4);

  // Lay PROMPT + buf (may contain "\n") into visual rows; find the cursor cell.
  function layout() {
    const w = innerW(), vis = [""];
    let r = 0, c = 0, curRow = 0, curCol = 0;
    const put = (ch) => { if (c >= w) { vis.push(""); r++; c = 0; } vis[r] += ch; c++; };
    for (const ch of PROMPT) put(ch);
    for (let k = 0; k <= buf.length; k++) {
      if (k === cursor) { curRow = r; curCol = c; }
      if (k === buf.length) break;
      if (buf[k] === "\n") { vis.push(""); r++; c = 0; } else put(buf[k]);
    }
    if (curCol >= w) { curRow++; curCol = 0; }
    if (curRow >= vis.length) vis.push("");
    return { vis, curRow, curCol, w };
  }

  function setRegion(h) {
    reserved = h;
    out(`\x1b[1;${Math.max(1, rows() - h)}r`); // scroll region = rows 1..(R-h)
  }

  // Draw the box at the absolute bottom rows. If `active`, leave the caret in
  // the box for editing; otherwise restore the conversation cursor (DECRC).
  function paintBox(active) {
    const { vis, curRow, curCol, w } = layout();
    const h = vis.length + 3; // top + content + bottom + hint
    if (h !== reserved) setRegion(h);
    const top = rows() - reserved + 1;
    const lines = [
      `${GRAY}╭${"─".repeat(w + 2)}╮${R}`,
      ...vis.map((ln, i) => {
        const txt = i === 0
          ? `${BLUE}${ln.slice(0, PROMPT.length)}${R}${ln.slice(PROMPT.length)}`
          : ln;
        return `${GRAY}│${R} ${txt}${" ".repeat(Math.max(0, w - ln.length))} ${GRAY}│${R}`;
      }),
      `${GRAY}╰${"─".repeat(w + 2)}╯${R}`,
      HINT,
    ];
    out("\x1b[?25l"); // hide caret while painting
    for (let i = 0; i < lines.length; i++) out(`\x1b[${top + i};1H\x1b[2K${lines[i]}`);
    if (active) out(`\x1b[${top + 1 + curRow};${3 + curCol}H`); // caret into the box
    else out("\x1b8");                                          // back to the conversation
    out("\x1b[?25h");
  }

  // Conversation output: the cursor already lives in the scroll region, so we
  // just write. The box (outside the region) is untouched and stays pinned.
  function print(s) { out(s); }

  function setBuf(next, cur) {
    buf = next;
    cursor = cur === undefined ? next.length : Math.max(0, Math.min(cur, next.length));
  }
  function insertNewline() { setBuf(buf.slice(0, cursor) + "\n" + buf.slice(cursor), cursor + 1); }
  function browseHistory(dir) {
    if (!history.length) return;
    if (histIdx === history.length) stash = buf;
    const n = histIdx + dir; if (n < 0 || n > history.length) return;
    histIdx = n; setBuf(histIdx === history.length ? stash : history[histIdx]);
  }

  function submit() {
    const text = buf;
    out("\x1b8");                       // restore conversation cursor (caret was in the box)
    out(`  ${BLUE}❯${R} ${text}\n`);    // echo into the transcript above the box
    out("\x1b7");                       // save the new conversation cursor
    if (text.trim()) history.push(text);
    histIdx = history.length; stash = "";
    setBuf("", 0);
    busy = true;
    paintBox(false);                    // leave an empty box pinned at the bottom
    Promise.resolve(onSubmit(text));    // caller drives the turn, then calls idle()
  }

  function onData(chunk) {
    let s = chunk.toString("utf8").replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\x03") return onQuit();                 // Ctrl+C always quits

      if (busy) { // streaming: only Esc interrupts; ignore typing
        if (ch === "\x1b" && i + 1 >= s.length) { onInterrupt?.(); return; }
        i++; continue;
      }

      if (ch === "\x1b") {
        const nxt = s[i + 1];
        if (nxt === "\r" || nxt === "\n") { insertNewline(); i += 2; continue; } // Alt/Option+Enter
        const rest = s.slice(i);
        const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/) || rest.match(/^\x1bO([A-Z])/);
        if (m) {
          if (m[0] === "\x1b[13;2u" || m[0] === "\x1b[27;2;13~") { insertNewline(); i += m[0].length; continue; } // Shift+Enter
          const code = m[2] ?? m[1];
          if (code === "D") cursor = Math.max(0, cursor - 1);
          else if (code === "C") cursor = Math.min(buf.length, cursor + 1);
          else if ((code === "A" || code === "B") && !buf.includes("\n")) browseHistory(code === "A" ? -1 : 1);
          else if (code === "H") cursor = 0;
          else if (code === "F") cursor = buf.length;
          else if (m[1] === "3" && code === "~") setBuf(buf.slice(0, cursor) + buf.slice(cursor + 1), cursor);
          i += m[0].length; continue;
        }
        i += 1; continue; // lone ESC
      }

      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") { submit(); return; }
      if (code === 4) { if (!buf) return onQuit(); i++; continue; }       // Ctrl+D
      if (code === 1) { cursor = 0; i++; continue; }                     // Ctrl+A
      if (code === 5) { cursor = buf.length; i++; continue; }            // Ctrl+E
      if (code === 21) { setBuf(buf.slice(cursor), 0); i++; continue; }  // Ctrl+U
      if (code === 23) {                                                 // Ctrl+W
        const left = buf.slice(0, cursor).replace(/\s*\S+\s*$/, "");
        setBuf(left + buf.slice(cursor), left.length); i++; continue;
      }
      if (code === 127 || code === 8) {                                  // Backspace
        if (cursor > 0) setBuf(buf.slice(0, cursor - 1) + buf.slice(cursor), cursor - 1);
        i++; continue;
      }
      if (code < 32) { i++; continue; }

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
    paintBox(true); // redraw box after edits, caret in the box
  }

  function attach() {
    if (listening) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    listening = true;
  }
  function detach() {
    if (!listening) return;
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    listening = false;
  }

  function onResize() { setRegion(reserved || 4); paintBox(!busy); }

  function start() {
    out("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback, home
    setRegion(4);
    out("\x1b[1;1H\x1b7");       // conversation cursor at the top, saved
    paintBox(false);            // empty box pinned at the bottom (restores cursor to top)
    attach();
  }

  return {
    start,
    print,
    idle() { out("\x1b7"); busy = false; paintBox(true); }, // save conv cursor, focus box
    suspend() { detach(); out("\x1b[r"); out("\x1b[2J\x1b[3J\x1b[H"); },
    resume() { start(); },
    clearConversation() {
      out("\x1b[2J\x1b[H");      // clear, cursor to top
      out("\x1b7");              // save conversation cursor at the top
      paintBox(busy);            // redraw box (restores cursor when not active)
    },
    stop() {
      detach();
      out("\x1b[r");             // reset scroll region
      out(`\x1b[${rows()};1H`);  // caret to the bottom
      out("\x1b[?25h\n");
    },
  };
}
