// `lite list` — print available harnesses and the configured server.

import { R, BOLD, CYAN, GRAY } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { HARNESSES } from "../harnesses.mjs";

export function list() {
  const config = loadConfig();
  process.stdout.write(`\n  ${BOLD}Harnesses${R}\n\n`);
  for (const h of HARNESSES) process.stdout.write(`  ${CYAN}${h}${R}\n`);
  if (config) process.stdout.write(`\n  ${GRAY}Server: ${config.url}${R}\n`);
  process.stdout.write("\n");
}
