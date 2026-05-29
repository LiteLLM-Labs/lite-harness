#!/usr/bin/env node
/**
 * lite CLI
 *
 * lite login             — save server URL + master key
 * lite list              — list available harnesses
 * lite models            — list models from the server
 * lite <harness-name>    — start a TUI chat session
 *   Flags: --model <id>  — override model (default: first from /v1/models)
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".config", "lite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
// Legacy location (pre `lite-harness` → `lite` rename) so existing logins keep working.
const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".config", "lite-harness", "config.json");

function loadConfig() {
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  return null;
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const GRAY   = "\x1b[90m";
const RED    = "\x1b[31m";
const WHITE  = "\x1b[97m";
const YELLOW = "\x1b[33m";
const BLUE   = "\x1b[38;5;117m"; // lite accent (light blue)
const ERASE  = "\r\x1b[K"; // move to col 0, erase line

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

const cols = () => process.stdout.columns || 80;
const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const up = (n) => (n > 0 ? `\x1b[${n}A` : "");

// ── Box drawing (rounded, ANSI-aware) ─────────────────────────────────────────
function drawBox(lines, { color = GRAY } = {}) {
  const w = cols() - 4; // fill the terminal width
  const top = `${color}╭${"─".repeat(w + 2)}╮${R}`;
  const bot = `${color}╰${"─".repeat(w + 2)}╯${R}`;
  const body = lines.map((line) => {
    const pad = " ".repeat(Math.max(0, w - visibleLen(line)));
    return `${color}│${R} ${line}${pad} ${color}│${R}`;
  });
  return ["", top, ...body, bot, ""].join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) flags.model = argv[++i];
    else if (argv[i].startsWith("--")) { /* ignore */ }
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

// ── login ─────────────────────────────────────────────────────────────────────
async function login() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existing = loadConfig();
    const defaultUrl = existing?.url || "http://localhost:4096";
    const rawUrl = (await ask(rl, `Server URL [${defaultUrl}]: `)).trim();
    const url   = (rawUrl || defaultUrl).replace(/\/+$/, "");
    const key   = (await ask(rl, "Master key (leave empty if none): ")).trim();

    const res = await fetch(`${url}/whoami`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) { console.error(`${RED}Login failed: HTTP ${res.status}${R}`); process.exit(1); }

    saveConfig({ url, key });
    console.log(`${GREEN}✓ Saved${R}  ${GRAY}${url}${R}`);
  } finally { rl.close(); }
}

// ── Streaming output renderer ─────────────────────────────────────────────────
// Renders the assistant turn the way Claude Code does: a dim "Thinking…" block
// for reasoning, "● tool(args)" lines with an indented "⎿" result, and the
// final answer as a bulleted block.
function makeRenderer() {
  const out = (s) => process.stdout.write(s);

  let spinnerTimer = null;
  let spinnerFrame = 0;
  let block = null;       // null | "text" | "reasoning"
  let atLineStart = true; // are we at the start of a fresh line?

  function startSpinner() {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      out(`${ERASE}  ${BLUE}${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]}${R} ${GRAY}working…${R}`);
    }, 80);
  }
  function stopSpinner() {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; out(ERASE); }
  }

  // Stream `text`, prefixing every fresh line with `prefix` (margin + color).
  function feed(text, prefix) {
    for (const ch of text) {
      if (ch === "\n") { out(R); out("\n"); atLineStart = true; }
      else { if (atLineStart) { out(prefix); atLineStart = false; } out(ch); }
    }
  }

  function closeBlock() {
    if (block && !atLineStart) { out(R); out("\n"); }
    block = null;
    atLineStart = true;
  }

  function text(delta) {
    stopSpinner();
    if (block !== "text") {
      closeBlock();
      out(`\n  ${BLUE}●${R} `);
      atLineStart = false;
      block = "text";
    }
    feed(delta, "    ");
  }

  function reasoning(delta) {
    stopSpinner();
    if (block !== "reasoning") {
      closeBlock();
      out(`\n  ${DIM}${ITALIC}✻ Thinking…${R}\n`);
      atLineStart = true;
      block = "reasoning";
    }
    feed(delta, `    ${DIM}${ITALIC}`);
  }

  function tool(toolName, state) {
    stopSpinner();
    closeBlock();
    const status = state?.status ?? "running";
    const dot = status === "completed" ? GREEN : status === "error" ? RED : YELLOW;
    let args = "";
    if (state?.input) {
      const s = typeof state.input === "string" ? state.input : JSON.stringify(state.input);
      args = ` ${GRAY}${s.length > 80 ? s.slice(0, 79) + "…" : s}${R}`;
    }
    out(`\n  ${dot}●${R} ${BOLD}${toolName}${R}${args}\n`);
    if ((status === "completed" || status === "error") && (state?.output || state?.error)) {
      const raw = state.error ?? state.output;
      const str = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      const lines = str.split("\n");
      lines.slice(0, 6).forEach((l, i) => {
        const branch = i === 0 ? "⎿ " : "  ";
        out(`    ${GRAY}${branch}${l.slice(0, cols() - 8)}${R}\n`);
      });
      if (lines.length > 6) out(`    ${GRAY}  … +${lines.length - 6} lines${R}\n`);
    }
    atLineStart = true;
  }

  function finish() {
    stopSpinner();
    closeBlock();
  }

  function error(msg) {
    stopSpinner();
    closeBlock();
    out(`\n  ${RED}● Error${R}  ${GRAY}${msg}${R}\n`);
    atLineStart = true;
  }

  return { startSpinner, stopSpinner, text, reasoning, tool, finish, error };
}

// ── Boxed input editor (raw mode, Claude-Code-style) ───────────────────────────
// Renders a rounded box around the prompt and edits a single logical line
// (auto-wrapped). Resolves the submitted string, or the EXIT sentinel on
// Ctrl+C / Ctrl+D-on-empty.
const EXIT = Symbol("exit");

function boxedPrompt(history) {
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
      const hint = `  ${GRAY}↵ send  ·  /clear  ·  exit${R}`;
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

// ── chat ──────────────────────────────────────────────────────────────────────
async function chat(harnessName, flags) {
  const config = loadConfig();
  if (!config) {
    console.error(`${RED}Not logged in. Run: lite login${R}`);
    process.exit(1);
  }

  const { url, key } = config;
  const authHdr = key ? { authorization: `Bearer ${key}` } : {};

  // Resolve model
  let model = flags.model;
  if (!model) {
    try {
      const r = await fetch(`${url}/v1/models`, { headers: authHdr });
      if (r.ok) { const d = await r.json(); model = d?.data?.[0]?.id; }
    } catch {}
  }
  model = model || "gpt-4o";

  // Create session
  const createRes = await fetch(`${url}/session`, {
    method: "POST",
    headers: { ...authHdr, "content-type": "application/json" },
    body: JSON.stringify({ title: "CLI session", harness: harnessName }),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    console.error(`${RED}Failed to create session: HTTP ${createRes.status}${body ? ` — ${body}` : ""}${R}`);
    process.exit(1);
  }

  const session = await createRes.json();
  let currentSid = session.id;

  // ── Welcome box ─────────────────────────────────────────────────────────────
  const shortUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  process.stdout.write(drawBox([
    `${BLUE}✻${R} ${BOLD}${WHITE}Welcome to lite${R}`,
    "",
    `${GRAY}harness${R}   ${CYAN}${harnessName}${R}`,
    `${GRAY}model${R}     ${model}`,
    `${GRAY}server${R}    ${shortUrl}`,
    `${GRAY}session${R}   ${currentSid.slice(0, 16)}`,
    "",
    `${DIM}/clear to reset history  ·  Esc to interrupt  ·  Ctrl+C to quit${R}`,
  ], { color: BLUE }));

  // ── SSE ─────────────────────────────────────────────────────────────────────
  const sseUrl = `${url}/event${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  const abort  = new AbortController();

  let idleResolve = null;
  const partWritten = new Map();
  const assistantMsgIds = new Set(); // only render parts for assistant messages
  const renderer = makeRenderer();

  async function sseLoop() {
    try {
      const res = await fetch(sseUrl, { signal: abort.signal, headers: authHdr });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            const evSid = ev?.properties?.sessionID ?? ev?.properties?.info?.sessionID;
            if (evSid !== currentSid) continue;
            handleEvent(ev);
          } catch {}
        }
      }
    } catch (e) {
      if (e?.name !== "AbortError") setTimeout(sseLoop, 2000);
    }
  }

  function handleEvent(ev) {
    if (ev.type === "message.updated") {
      const info = ev.properties?.info;
      if (info?.id && info?.role === "assistant") assistantMsgIds.add(info.id);
    } else if (ev.type === "message.part.delta") {
      const { field, delta, partID, messageID } = ev.properties ?? {};
      if (!delta || !assistantMsgIds.has(messageID)) return;
      if (field === "text") renderer.text(delta);
      else if (field === "reasoning") renderer.reasoning(delta);
      else return;
      partWritten.set(partID, (partWritten.get(partID) ?? 0) + delta.length);
    } else if (ev.type === "message.part.updated") {
      const part = ev.properties?.part;
      if (!part?.id || !assistantMsgIds.has(part.messageID)) return;
      if ((part.type === "text" || part.type === "reasoning" || part.type === "thinking") && part.text) {
        const written = partWritten.get(part.id) ?? 0;
        const tail = part.text.slice(written);
        if (tail) {
          if (part.type === "text") renderer.text(tail);
          else renderer.reasoning(tail);
          partWritten.set(part.id, part.text.length);
        }
      } else if (part.type === "tool" && part.tool) {
        renderer.tool(part.tool, part.state);
        partWritten.set(part.id, 1); // mark rendered
      }
    } else if (ev.type === "session.idle") {
      renderer.finish();
      partWritten.clear();
      assistantMsgIds.clear();
      idleResolve?.();
      idleResolve = null;
    } else if (ev.type === "session.error") {
      const errObj = ev.properties?.error;
      const msg = errObj?.data?.message ?? errObj?.message ?? JSON.stringify(errObj ?? ev.properties);
      renderer.error(msg);
      partWritten.clear();
      idleResolve?.();
      idleResolve = null;
    }
  }

  sseLoop();

  // ── Session clear ───────────────────────────────────────────────────────────
  async function clearSession() {
    await fetch(`${url}/session/${encodeURIComponent(currentSid)}`, {
      method: "DELETE", headers: authHdr,
    }).catch(() => {});
    const r = await fetch(`${url}/session`, {
      method: "POST",
      headers: { ...authHdr, "content-type": "application/json" },
      body: JSON.stringify({ title: "CLI session", harness: harnessName }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    currentSid = s.id;
    partWritten.clear();
    assistantMsgIds.clear();
    idleResolve = null;
    process.stdout.write(`\n  ${GREEN}✓ Session cleared${R}  ${GRAY}${currentSid.slice(0, 12)}${R}\n`);
  }

  function quit() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    abort.abort();
    process.stdout.write("\n");
    process.exit(0);
  }

  async function sendAndWait(text) {
    const done = new Promise((resolve) => { idleResolve = resolve; });
    renderer.startSpinner();

    // While streaming, watch for Esc (interrupt) / Ctrl+C (quit).
    let onKey = null;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      onKey = (d) => {
        const k = d.toString("utf8");
        if (k.includes("\x03")) quit();                  // Ctrl+C
        else if (k === "\x1b") {                          // bare Esc → interrupt
          renderer.finish();
          process.stdout.write(`  ${GRAY}interrupted${R}\n`);
          idleResolve?.(); idleResolve = null;
        }
      };
      process.stdin.on("data", onKey);
    }

    try {
      const r = await fetch(`${url}/session/${encodeURIComponent(currentSid)}/prompt_async`, {
        method: "POST",
        headers: { ...authHdr, "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "litellm", modelID: model },
          parts: [{ type: "text", text }],
        }),
      });
      if (!r.ok) {
        renderer.stopSpinner();
        const body = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      const timeout = new Promise((resolve) => setTimeout(resolve, 600_000));
      await Promise.race([done, timeout]);
    } finally {
      idleResolve = null;
      if (onKey) {
        process.stdin.removeListener("data", onKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      }
    }
  }

  // ── Input loop ──────────────────────────────────────────────────────────────
  const history = [];

  while (true) {
    const input = await boxedPrompt(history);
    if (input === EXIT) quit();
    const text = input.trim();
    if (!text) continue;
    if (text === "exit" || text === "quit" || text === "\\q") quit();

    history.push(text);
    process.stdout.write(`  ${BLUE}❯${R} ${text}\n`); // echo as scrollback

    if (text === "/clear") {
      try { await clearSession(); } catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n`); }
      process.stdout.write("\n");
      continue;
    }

    try {
      await sendAndWait(text);
    } catch (e) {
      renderer.error(e.message);
    }
    process.stdout.write("\n");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

const HARNESSES = ["opencode", "claude-code", "github-copilot", "codex"];

function printHelp() {
  process.stdout.write([
    "",
    `  ${BOLD}${WHITE}lite${R}  ${GRAY}— terminal chat for lite-harness${R}`,
    "",
    `  ${CYAN}login${R}              save server URL + master key`,
    `  ${CYAN}list${R}               list available harnesses`,
    `  ${CYAN}models${R}             list models from the server`,
    `  ${CYAN}<harness>${R}          start a chat session`,
    `    ${GRAY}--model <id>${R}     override model ${GRAY}(default: first from server)${R}`,
    "",
    `  ${GRAY}Harnesses: ${HARNESSES.join("  ")}${R}`,
    "",
  ].join("\n"));
}

if (!cmd || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(cmd ? 0 : 1);
}

if (cmd === "login") {
  await login();
} else if (cmd === "list") {
  const config = loadConfig();
  process.stdout.write(`\n  ${BOLD}Harnesses${R}\n\n`);
  for (const h of HARNESSES) process.stdout.write(`  ${CYAN}${h}${R}\n`);
  if (config) process.stdout.write(`\n  ${GRAY}Server: ${config.url}${R}\n`);
  process.stdout.write("\n");
} else if (cmd === "models") {
  const config = loadConfig();
  if (!config) { console.error(`${RED}Not logged in. Run: lite login${R}`); process.exit(1); }
  const { url, key } = config;
  const r = await fetch(`${url}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!r.ok) { console.error(`${RED}HTTP ${r.status}${R}`); process.exit(1); }
  const data = await r.json();
  const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  process.stdout.write(`\n  ${BOLD}Models${R}  ${GRAY}(${ids.length})${R}\n\n`);
  for (const id of ids) process.stdout.write(`  ${id}\n`);
  process.stdout.write("\n");
} else {
  await chat(cmd, flags);
}
