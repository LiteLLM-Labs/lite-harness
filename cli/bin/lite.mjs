#!/usr/bin/env node
/**
 * lite CLI — entry point. Parses argv and dispatches to a command.
 *
 * lite login             — save server URL + master key
 * lite list              — list available harnesses
 * lite models            — list models from the server
 * lite <harness-name>    — start a TUI chat session
 *   Flags: --model <id>  — override model (default: first from /v1/models)
 */

import { R, BOLD, CYAN, GRAY, WHITE } from "../src/ansi.mjs";
import { BUILTIN_AGENTS } from "../src/agents.mjs";
import { login } from "../src/commands/login.mjs";
import { list } from "../src/commands/list.mjs";
import { models } from "../src/commands/models.mjs";
import { chat } from "../src/commands/chat.mjs";

function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model" && argv[i + 1]) flags.model = argv[++i];
    else if (argv[i].startsWith("--")) { /* ignore */ }
    else positional.push(argv[i]);
  }
  return { flags, positional };
}

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
    `  ${GRAY}Agents: ${BUILTIN_AGENTS.join("  ")}${R}`,
    "",
  ].join("\n"));
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd] = positional;

if (!cmd || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(cmd ? 0 : 1);
} else if (cmd === "login") {
  await login();
} else if (cmd === "list") {
  await list();
} else if (cmd === "models") {
  await models();
} else {
  await chat(cmd, flags);
}
