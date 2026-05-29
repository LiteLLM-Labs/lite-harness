#!/usr/bin/env node
/**
 * lite CLI
 *
 * lite login             — save server URL + master key
 * lite <harness-name>    — start a TUI chat session
 *   Flags: --model <id>          — override model (default: first from /v1/models)
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".config", "lite");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return null; }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const GRAY   = "\x1b[90m";
const RED    = "\x1b[31m";
const WHITE  = "\x1b[97m";
const YELLOW = "\x1b[33m";
const ERASE  = "\r\x1b[K"; // move to col 0, erase line

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

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
function makeRenderer() {
  let spinnerTimer  = null;
  let spinnerFrame  = 0;
  let spinnerActive = false;
  let firstChunk    = true;
  let atLineStart   = true;

  function startSpinner() {
    spinnerActive = true;
    spinnerTimer = setInterval(() => {
      process.stdout.write(
        `${ERASE}  ${GRAY}${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]} thinking…${R}`
      );
    }, 80);
  }

  function stopSpinner() {
    if (!spinnerActive) return;
    clearInterval(spinnerTimer);
    spinnerActive = false;
    process.stdout.write(ERASE);
  }

  function writeChunk(text) {
    if (firstChunk) {
      stopSpinner();
      process.stdout.write("  ");
      atLineStart = false;
      firstChunk  = false;
    }
    for (const ch of text) {
      if (ch === "\n") {
        process.stdout.write("\n");
        atLineStart = true;
      } else {
        if (atLineStart) { process.stdout.write("  "); atLineStart = false; }
        process.stdout.write(ch);
      }
    }
  }

  function finish() {
    stopSpinner();
    if (!atLineStart) process.stdout.write("\n");
    firstChunk  = true;
    atLineStart = true;
  }

  function error(msg) {
    stopSpinner();
    if (!atLineStart) process.stdout.write("\n");
    process.stdout.write(`  ${RED}✗ ${msg}${R}\n`);
    firstChunk  = true;
    atLineStart = true;
  }

  function writeTool(toolName, state) {
    stopSpinner();
    if (!atLineStart) { process.stdout.write("\n"); atLineStart = true; }
    const status = state?.status ?? "running";
    const icon = status === "completed" ? `${GREEN}✓${R}` : status === "error" ? `${RED}✗${R}` : `${YELLOW}⚙${R}`;
    const inputSnippet = state?.input ? ` ${GRAY}${JSON.stringify(state.input).slice(0, 80)}${R}` : "";
    process.stdout.write(`  ${icon} ${BOLD}${toolName}${R}${inputSnippet}\n`);
    if ((status === "completed" || status === "error") && (state?.output || state?.error)) {
      const out = state.error ?? state.output;
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const lines = text.split("\n").slice(0, 8);
      for (const l of lines) process.stdout.write(`    ${GRAY}${l}${R}\n`);
      if (text.split("\n").length > 8) process.stdout.write(`    ${GRAY}…${R}\n`);
    }
    firstChunk = true;
  }

  return { startSpinner, stopSpinner, writeChunk, writeTool, finish, error };
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

  // ── Banner ────────────────────────────────────────────────────────────────
  const shortUrl = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  process.stdout.write("\n");
  process.stdout.write(`  ${BOLD}${WHITE}lite${R}  ${CYAN}${harnessName}${R}\n`);
  process.stdout.write(`  ${GRAY}${model}  ·  ${shortUrl}  ·  ${currentSid.slice(0, 12)}${R}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  ${DIM}/clear to reset history  ·  Ctrl+C or "exit" to quit${R}\n`);
  process.stdout.write(`\n`);

  // ── SSE ───────────────────────────────────────────────────────────────────
  const sseUrl = `${url}/event${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  const abort  = new AbortController();

  let idleResolve = null;
  const partWritten = new Map();
  const assistantMsgIds = new Set(); // only render parts for assistant messages
  const renderer = makeRenderer();
  let responseActive = false;

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
      if (field === "text" && delta && assistantMsgIds.has(messageID)) {
        responseActive = true;
        renderer.writeChunk(delta);
        partWritten.set(partID, (partWritten.get(partID) ?? 0) + delta.length);
      }
    } else if (ev.type === "message.part.updated") {
      const part = ev.properties?.part;
      if (!part?.id || !assistantMsgIds.has(part.messageID)) return;
      if (part.type === "text" && part.text) {
        const written = partWritten.get(part.id) ?? 0;
        const tail = part.text.slice(written);
        if (tail) {
          responseActive = true;
          renderer.writeChunk(tail);
          partWritten.set(part.id, part.text.length);
        }
      } else if (part.type === "tool" && part.tool) {
        renderer.writeTool(part.tool, part.state);
        partWritten.set(part.id, 1); // mark rendered
      }
    } else if (ev.type === "session.idle") {
      renderer.finish();
      partWritten.clear();
      assistantMsgIds.clear();
      responseActive = false;
      idleResolve?.();
      idleResolve = null;
    } else if (ev.type === "session.error") {
      const errObj = ev.properties?.error;
      const msg = errObj?.data?.message ?? errObj?.message ?? JSON.stringify(errObj ?? ev.properties);
      renderer.error(msg);
      partWritten.clear();
      responseActive = false;
      idleResolve?.();
      idleResolve = null;
    }
  }

  sseLoop();

  // ── Session clear ─────────────────────────────────────────────────────────
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
    responseActive = false;
    idleResolve = null;
    process.stdout.write(`  ${GREEN}✓ Session cleared${R}  ${GRAY}${currentSid.slice(0, 12)}${R}\n\n`);
  }

  async function sendAndWait(text) {
    const done = new Promise((resolve) => { idleResolve = resolve; });
    renderer.startSpinner();

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

    const timeout = new Promise((resolve) => setTimeout(resolve, 180_000));
    await Promise.race([done, timeout]);
    idleResolve = null;
  }

  // ── Raw input with bracketed paste support ────────────────────────────────
  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let lineBuf  = "";
  let pasteBuf = null; // non-null = inside a bracketed paste
  let escBuf   = "";   // accumulate escape sequences
  let busy     = false;

  function showPrompt() {
    process.stdout.write(`${CYAN}❯${R} `);
  }

  async function handleText(text) {
    if (!text) { showPrompt(); return; }

    if (text === "exit" || text === "quit" || text === "\\q") {
      process.stdout.write("\x1b[?2004l");
      process.stdin.setRawMode(false);
      abort.abort();
      process.exit(0);
    }

    if (text === "/clear") {
      try { await clearSession(); } catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n\n`); }
      showPrompt();
      return;
    }

    process.stdout.write("\n");
    busy = true;
    try {
      await sendAndWait(text);
    } catch (e) {
      process.stdout.write(`  ${RED}✗ ${e.message}${R}\n`);
    }
    process.stdout.write("\n");
    busy = false;
    showPrompt();
  }

  process.stdin.on("data", (data) => {
    for (let i = 0; i < data.length; ) {
      const rest = data.slice(i);

      if (rest.startsWith("\x1b[200~")) { pasteBuf = ""; i += 6; continue; }

      if (pasteBuf !== null && rest.startsWith("\x1b[201~")) {
        const text = (lineBuf + pasteBuf).trim();
        lineBuf = ""; pasteBuf = null; i += 6;
        if (text) { process.stdout.write("\n"); handleText(text); }
        continue;
      }

      const ch = data[i++];

      if (pasteBuf !== null) {
        if (ch !== "\r") { pasteBuf += ch; process.stdout.write(ch); }
        continue;
      }

      // Escape: bare \x1b with no following bytes in this chunk = Escape key
      if (ch === "\x1b" && i === data.length) {
        if (busy) { renderer.finish(); assistantMsgIds.clear(); partWritten.clear(); idleResolve?.(); idleResolve = null; }
        continue;
      }

      // Skip multi-char escape sequences (arrow keys etc.)
      if (escBuf || ch === "\x1b") {
        escBuf += ch;
        if (escBuf.length > 1 && /[A-Za-z~]/.test(ch)) escBuf = "";
        continue;
      }

      if (busy) continue; // ignore typed input while response is streaming

      if (ch === "\r" || ch === "\n") {
        const text = lineBuf.trim(); lineBuf = "";
        process.stdout.write("\n");
        handleText(text);
      } else if (ch === "\x7f") { // backspace
        if (lineBuf.length > 0) { lineBuf = lineBuf.slice(0, -1); process.stdout.write("\b \b"); }
      } else if (ch === "\x03" || ch === "\x04") { // Ctrl+C / Ctrl+D
        process.stdout.write("\n");
        process.stdout.write("\x1b[?2004l");
        process.stdin.setRawMode(false);
        abort.abort();
        process.exit(0);
      } else if (ch === "\x15") { // Ctrl+U — clear line
        process.stdout.write("\r\x1b[K");
        showPrompt();
        lineBuf = "";
      } else if (ch >= " ") {
        lineBuf += ch; process.stdout.write(ch);
      }
    }
  });

  showPrompt();
  await new Promise(() => {}); // keep alive; exit via process.exit above
}

// ── Entry point ───────────────────────────────────────────────────────────────
const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

const HARNESSES = ["opencode", "claude-code", "github-copilot", "codex"];

function printHelp() {
  process.stdout.write([
    "",
    `  ${BOLD}${WHITE}lite${R}`,
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
