// `lite login` — prompt for server URL + master key, verify, and save.

import readline from "node:readline";
import { R, RED, GREEN, GRAY } from "../ansi.mjs";
import { loadConfig, saveConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";

const ask = (rl, prompt) => new Promise((resolve) => rl.question(prompt, resolve));

export async function login() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const existing = loadConfig();
    const defaultUrl = existing?.url || "http://localhost:4096";
    const rawUrl = (await ask(rl, `Server URL [${defaultUrl}]: `)).trim();
    const url = (rawUrl || defaultUrl).replace(/\/+$/, "");
    const key = (await ask(rl, "Master key (leave empty if none): ")).trim();

    const res = await new LiteClient({ url, key }).whoami();
    if (!res.ok) { console.error(`${RED}Login failed: HTTP ${res.status}${R}`); process.exit(1); }

    saveConfig({ url, key });
    console.log(`${GREEN}✓ Saved${R}  ${GRAY}${url}${R}`);
  } finally { rl.close(); }
}
