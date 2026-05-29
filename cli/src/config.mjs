// Credentials live at ~/.config/lite/config.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "lite");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
// Legacy location (pre `lite-harness` → `lite` rename) so existing logins keep working.
const LEGACY_CONFIG_FILE = path.join(os.homedir(), ".config", "lite-harness", "config.json");

export function loadConfig() {
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  }
  return null;
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
