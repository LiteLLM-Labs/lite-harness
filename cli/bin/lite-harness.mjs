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

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".config", "lite-harness");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── ANSI ─────────────────────────────────────────────────────────────────────
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";
const RED = "\x1b[31m";

// ── Helpers ──────────────────────────────────────────────────────────────────
function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) {
      flags.model = argv[++i];
    } else if (argv[i].startsWith("--")) {
      // ignore unknown flags
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

// ── login ────────────────────────────────────────────────────────────────────
async function login() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existing = loadConfig();
    const defaultUrl = existing?.url || "http://localhost:4096";

    const rawUrl = (await ask(rl, `Server URL [${defaultUrl}]: `)).trim();
    const url = (rawUrl || defaultUrl).replace(/\/+$/, "");
    const key = (await ask(rl, "Master key (leave empty if none): ")).trim();

    const res = await fetch(`${url}/whoami`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });

    if (!res.ok) {
      console.error(`${RED}Login failed: HTTP ${res.status}${R}`);
      process.exit(1);
    }

    saveConfig({ url, key });
    console.log(`${GREEN}Saved.${R} ${GRAY}${url}${R}`);
  } finally {
    rl.close();
  }
}

// ── chat ─────────────────────────────────────────────────────────────────────
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
      if (r.ok) {
        const d = await r.json();
        model = d?.data?.[0]?.id;
      }
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

  console.log(`${GRAY}${harnessName} · ${url} · ${currentSid.slice(0, 12)} · model: ${model}${R}`);
  console.log(`${DIM}Ctrl+C, "exit", or "/clear" to clear history${R}\n`);

  // ── SSE subscriber ──────────────────────────────────────────────────────
  const sseUrl = `${url}/event${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  const abort = new AbortController();

  // Resolve / reject when session goes idle or errors
  let idleResolve = null;
  // Track which parts have been written (partID → char count written)
  const partWritten = new Map();
  let streamStarted = false;

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
            const evSid =
              ev?.properties?.sessionID ??
              ev?.properties?.info?.sessionID;
            if (evSid !== currentSid) continue;
            handleEvent(ev);
          } catch {}
        }
      }
    } catch (e) {
      if (e?.name !== "AbortError") {
        // Reconnect after brief pause
        setTimeout(sseLoop, 2000);
      }
    }
  }

  async function clearSession() {
    // Delete current session
    await fetch(`${url}/session/${encodeURIComponent(currentSid)}`, {
      method: "DELETE",
      headers: authHdr,
    }).catch(() => {});

    // Create fresh session
    const r = await fetch(`${url}/session`, {
      method: "POST",
      headers: { ...authHdr, "content-type": "application/json" },
      body: JSON.stringify({ title: "CLI session", harness: harnessName }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    currentSid = s.id;
    partWritten.clear();
    streamStarted = false;
    idleResolve = null;
    process.stdout.write(`${GRAY}Session cleared · ${currentSid.slice(0, 12)}${R}\n\n`);
  }

  function handleEvent(ev) {
    if (ev.type === "message.part.delta") {
      const { field, delta, partID } = ev.properties ?? {};
      if (field === "text" && delta) {
        if (!streamStarted) { process.stdout.write("\n"); streamStarted = true; }
        process.stdout.write(delta);
        partWritten.set(partID, (partWritten.get(partID) ?? 0) + delta.length);
      }
    } else if (ev.type === "message.part.updated") {
      // Fallback for harnesses that don't emit deltas (e.g. opencode)
      const part = ev.properties?.part;
      if (part?.type === "text" && part?.id && part?.text) {
        const written = partWritten.get(part.id) ?? 0;
        const tail = part.text.slice(written);
        if (tail) {
          if (!streamStarted) { process.stdout.write("\n"); streamStarted = true; }
          process.stdout.write(tail);
          partWritten.set(part.id, part.text.length);
        }
      }
    } else if (ev.type === "session.idle") {
      if (streamStarted) { process.stdout.write("\n"); streamStarted = false; }
      partWritten.clear();
      idleResolve?.();
      idleResolve = null;
    } else if (ev.type === "session.error") {
      const errObj = ev.properties?.error;
      const msg =
        errObj?.data?.message ??
        errObj?.message ??
        JSON.stringify(errObj ?? ev.properties);
      if (streamStarted) { process.stdout.write("\n"); streamStarted = false; }
      process.stdout.write(`${RED}Error: ${msg}${R}\n`);
      partWritten.clear();
      idleResolve?.();
      idleResolve = null;
    }
  }

  sseLoop();

  // ── readline chat loop ──────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("close", () => {
    abort.abort();
    process.exit(0);
  });

  async function sendAndWait(text) {
    const done = new Promise((resolve) => { idleResolve = resolve; });

    const r = await fetch(
      `${url}/session/${encodeURIComponent(currentSid)}/prompt_async`,
      {
        method: "POST",
        headers: { ...authHdr, "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerID: "litellm", modelID: model },
          parts: [{ type: "text", text }],
        }),
      },
    );

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    // Wait up to 3 min for session.idle; bail out gracefully on timeout
    const timeout = new Promise((resolve) => setTimeout(resolve, 180_000));
    await Promise.race([done, timeout]);
    idleResolve = null;
  }

  // Main loop
  while (true) {
    const input = await new Promise((resolve) =>
      rl.question(`${BOLD}You:${R} `, resolve),
    );
    const text = input.trim();

    if (!text) continue;
    if (text === "exit" || text === "quit" || text === "\\q") {
      rl.close();
      break;
    }
    if (text === "/clear") {
      try {
        await clearSession();
      } catch (e) {
        process.stdout.write(`${RED}clear error: ${e.message}${R}\n`);
      }
      continue;
    }

    try {
      await sendAndWait(text);
    } catch (e) {
      process.stdout.write(`${RED}send error: ${e.message}${R}\n`);
    }

    process.stdout.write("\n");
  }

  abort.abort();
}

// ── Entry point ───────────────────────────────────────────────────────────────
const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

const HARNESSES = ["opencode", "claude-code", "github-copilot"];

function printHelp() {
  console.log([
    `${BOLD}lite-harness${R}`,
    "",
    `  ${BOLD}lite-harness login${R}                  save server URL + master key`,
    `  ${BOLD}lite-harness list${R}                   list available harnesses`,
    `  ${BOLD}lite-harness models${R}                 list models from server`,
    `  ${BOLD}lite-harness <harness>${R}               start a chat session`,
    `    --model <id>                  override model (default: first from server)`,
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
  console.log(`${BOLD}Harnesses:${R}`);
  for (const h of HARNESSES) {
    console.log(`  ${h}`);
  }
  if (config) {
    console.log(`\n${GRAY}Server: ${config.url}${R}`);
  }
} else if (cmd === "models") {
  const config = loadConfig();
  if (!config) {
    console.error(`${RED}Not logged in. Run: lite-harness login${R}`);
    process.exit(1);
  }
  const { url, key } = config;
  const r = await fetch(`${url}/v1/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!r.ok) {
    console.error(`${RED}HTTP ${r.status}${R}`);
    process.exit(1);
  }
  const data = await r.json();
  const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  if (!ids.length) {
    console.log(`${GRAY}No models returned.${R}`);
  } else {
    console.log(`${BOLD}Models (${ids.length}):${R}`);
    for (const id of ids) console.log(`  ${id}`);
  }
} else {
  await chat(cmd, flags);
}
