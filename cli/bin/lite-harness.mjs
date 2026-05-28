#!/usr/bin/env node
/**
 * lite-harness CLI
 *
 * lite-harness login             — save server URL + master key
 * lite-harness <harness-name>    — start a TUI chat session
 *   Flags: --model <id>          — override model (default: first from /v1/models)
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".config", "lite-harness");
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
const R     = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const CYAN  = "\x1b[36m";
const GREEN = "\x1b[32m";
const GRAY  = "\x1b[90m";
const RED   = "\x1b[31m";
const WHITE = "\x1b[97m";
const ERASE = "\r\x1b[K"; // move to col 0, erase line

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const BORDER = `  ${GRAY}│${R} `;

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
  let firstChunk    = true;   // true until first text arrives
  let atLineStart   = true;   // track position for border prefix

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
      process.stdout.write(BORDER);
      atLineStart = false;
      firstChunk  = false;
    }
    for (const ch of text) {
      if (ch === "\n") {
        process.stdout.write("\n");
        atLineStart = true;
      } else {
        if (atLineStart) { process.stdout.write(BORDER); atLineStart = false; }
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

  return { startSpinner, stopSpinner, writeChunk, finish, error };
}

// ── chat ──────────────────────────────────────────────────────────────────────
async function chat(harnessName, flags) {
  const config = loadConfig();
  if (!config) {
    console.error(`${RED}Not logged in. Run: lite-harness login${R}`);
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
  process.stdout.write(`  ${BOLD}${WHITE}lite-harness${R}  ${CYAN}${harnessName}${R}\n`);
  process.stdout.write(`  ${GRAY}${model}  ·  ${shortUrl}  ·  ${currentSid.slice(0, 12)}${R}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  ${DIM}/clear to reset history  ·  Ctrl+C or "exit" to quit${R}\n`);
  process.stdout.write(`\n`);

  // ── SSE ───────────────────────────────────────────────────────────────────
  const sseUrl = `${url}/event${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  const abort  = new AbortController();

  let idleResolve = null;
  const partWritten = new Map();
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
    if (ev.type === "message.part.delta") {
      const { field, delta, partID } = ev.properties ?? {};
      if (field === "text" && delta) {
        responseActive = true;
        renderer.writeChunk(delta);
        partWritten.set(partID, (partWritten.get(partID) ?? 0) + delta.length);
      }
    } else if (ev.type === "message.part.updated") {
      const part = ev.properties?.part;
      if (part?.type === "text" && part?.id && part?.text) {
        const written = partWritten.get(part.id) ?? 0;
        const tail = part.text.slice(written);
        if (tail) {
          responseActive = true;
          renderer.writeChunk(tail);
          partWritten.set(part.id, part.text.length);
        }
      }
    } else if (ev.type === "session.idle") {
      renderer.finish();
      partWritten.clear();
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
    responseActive = false;
    idleResolve = null;
    process.stdout.write(`  ${GREEN}✓ Session cleared${R}  ${GRAY}${currentSid.slice(0, 12)}${R}\n\n`);
  }

  // ── readline loop ─────────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("close", () => { abort.abort(); process.exit(0); });

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

  while (true) {
    const input = await new Promise((resolve) =>
      rl.question(`${CYAN}❯${R} `, resolve)
    );
    const text = input.trim();
    if (!text) continue;

    if (text === "exit" || text === "quit" || text === "\\q") { rl.close(); break; }

    if (text === "/clear") {
      try { await clearSession(); } catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n\n`); }
      continue;
    }

    process.stdout.write("\n");
    try {
      await sendAndWait(text);
    } catch (e) {
      process.stdout.write(`  ${RED}✗ ${e.message}${R}\n`);
    }
    process.stdout.write("\n");
  }

  abort.abort();
}

// ── Entry point ───────────────────────────────────────────────────────────────
const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

const HARNESSES = ["opencode", "claude-code", "github-copilot", "codex"];

function printHelp() {
  process.stdout.write([
    "",
    `  ${BOLD}${WHITE}lite-harness${R}`,
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
  if (!config) { console.error(`${RED}Not logged in. Run: lite-harness login${R}`); process.exit(1); }
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
