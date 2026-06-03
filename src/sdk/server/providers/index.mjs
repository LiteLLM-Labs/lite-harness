// Provider registry with auto-discovery.
//
// Each subfolder of this directory is one provider: an `index.mjs` that exports
//   - `id`           — canonical agent/harness id (string)
//   - `aliases`      — optional alternate ids (string[])
//   - `createRuntime`— factory returning a runtime ({ runTurn, interrupt, ... })
//
// Adding a provider = drop a folder. Nothing here changes. The id→provider map
// is built by scanning, not hand-wired (mirrors litellm-rust providers/mod.rs).
//
// `LITE_HARNESS_PROVIDERS_DIR` may point at an extra directory of provider
// folders (external/test providers); it is merged on top of the built-ins.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const builtinDir = dirname(fileURLToPath(import.meta.url));
let registry = null;

function providerDirs() {
  const dirs = [builtinDir];
  const extra = process.env.LITE_HARNESS_PROVIDERS_DIR;
  if (extra) dirs.push(extra);
  return dirs;
}

async function discover() {
  const map = new Map();
  for (const dir of providerDirs()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexUrl = pathToFileURL(join(dir, entry.name, "index.mjs")).href;
      let mod;
      try {
        mod = await import(indexUrl);
      } catch {
        continue; // not a provider folder
      }
      if (!mod || typeof mod.id !== "string" || typeof mod.createRuntime !== "function") continue;
      for (const key of [mod.id, ...(mod.aliases ?? [])]) {
        map.set(String(key).toLowerCase(), mod);
      }
    }
  }
  return map;
}

export async function loadProviders() {
  if (!registry) registry = await discover();
  return registry;
}

export async function resolveProvider(agent) {
  const map = await loadProviders();
  const mod = map.get(String(agent ?? "").toLowerCase());
  if (!mod) {
    throw new Error(`unsupported agent: ${agent} (known: ${[...map.keys()].join(", ")})`);
  }
  return mod;
}

export async function listProviderMetadata() {
  const map = await loadProviders();
  const seen = new Set();
  const providers = [];

  for (const mod of map.values()) {
    if (seen.has(mod.id)) continue;
    seen.add(mod.id);
    const aliases = Array.isArray(mod.aliases) ? mod.aliases.filter((alias) => typeof alias === "string") : [];
    const models = Array.isArray(mod.models) ? mod.models.filter((model) => typeof model === "string") : [];
    providers.push({
      id: mod.harnessId || mod.id,
      providerId: mod.id,
      name: mod.displayName || mod.id,
      aliases,
    });
  }

  return providers.sort((a, b) => a.name.localeCompare(b.name));
}
