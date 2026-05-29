// `lite list` — print available agents and the configured server.

import { R, BOLD, CYAN, GRAY, GREEN } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";
import { BUILTIN_AGENTS } from "../agents.mjs";

export async function list() {
  const config = loadConfig();

  process.stdout.write(`\n  ${BOLD}Built-in agents${R}\n\n`);
  for (const a of BUILTIN_AGENTS) process.stdout.write(`  ${CYAN}${a}${R}\n`);

  if (config) {
    const client = new LiteClient(config);
    try {
      const saved = await client.listAgents();
      if (saved.length > 0) {
        process.stdout.write(`\n  ${BOLD}Saved agents${R}\n\n`);
        for (const a of saved) {
          const date = new Date(a.created_at).toLocaleDateString();
          process.stdout.write(`  ${GREEN}${a.name}${R}  ${GRAY}${a.base_agent} · ${date}${R}\n`);
        }
      }
    } catch {}
    process.stdout.write(`\n  ${GRAY}Server: ${config.url}${R}\n`);
  }
  process.stdout.write("\n");
}
