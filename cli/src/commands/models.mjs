// `lite models` — list the model ids the server advertises.

import { R, BOLD, GRAY, RED } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";

export async function models() {
  const config = loadConfig();
  if (!config) { console.error(`${RED}Not logged in. Run: lite login${R}`); process.exit(1); }

  let ids;
  try {
    ids = await new LiteClient(config).listModels();
  } catch (e) {
    console.error(`${RED}${e.message}${R}`); process.exit(1);
  }

  process.stdout.write(`\n  ${BOLD}Models${R}  ${GRAY}(${ids.length})${R}\n\n`);
  for (const id of ids) process.stdout.write(`  ${id}\n`);
  process.stdout.write("\n");
}
