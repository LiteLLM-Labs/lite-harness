#!/usr/bin/env node
/**
 * Sandbox MCP stdio server — thin wrapper around mcp/sandbox.mjs.
 *
 * Used by opencode's gen-mcp-config.mjs as a local stdio MCP process.
 * The actual provider logic lives in mcp/sandbox.mjs, which is also registered
 * in the platform MCP so all harnesses (cc, copilot, codex, opencode) get
 * sandbox tools via PLATFORM_MCP_URL without needing this stdio process.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  SANDBOX_TOOL_DEFINITIONS,
  readEnvConfig,
  buildProvider,
  createState,
  createHandlers,
  cleanupSandboxes,
} from "../../mcp/sandbox.mjs";
import { buildBackend, VAULT_DB_PATH } from "../vault-backend.mjs";

const config = readEnvConfig();
const state  = createState();

let provider = null;
let providerError = null;

if (!config.platformMode) {
  const result = buildProvider(config);
  provider      = result.provider ?? null;
  providerError = result.error ?? null;
}

let _vaultBackend = null;
try {
  _vaultBackend = buildBackend(config.token, VAULT_DB_PATH);
} catch (e) {
  console.error(`[sandbox-mcp] vault unavailable (${VAULT_DB_PATH}): ${e.message}`);
}

const getVaultEnvs = async () => {
  if (!_vaultBackend) return {};
  try {
    const all = await _vaultBackend.getAll();
    // Vault stores keys as "owner_id:KEY_NAME". Strip the prefix so env vars
    // are available as plain KEY_NAME inside the sandbox.
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      const colon = k.indexOf(":");
      out[colon >= 0 ? k.slice(colon + 1) : k] = v;
    }
    return out;
  } catch { return {}; }
};

const MODE = config.platformMode ? "platform" : (provider?.providerName ?? "none");
console.error(`[sandbox-mcp] mode=${config.platformMode ? "platform" : "direct"} provider=${MODE}`);

const { handleProvision, handleExecute, handleReadFile, handleUploadArtifact } =
  createHandlers({ config, state, provider, providerError, getVaultEnvs });

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "opencode-sandbox", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

// Remap prefixed names (sandbox_provision → provision) for backward compat
// with opencode sessions that call the tools by their short names.
const SHORT_TOOLS = SANDBOX_TOOL_DEFINITIONS.map(d => ({
  ...d,
  name: d.name.replace(/^sandbox_/, ""),
}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: SHORT_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision")       return handleProvision(args ?? {});
  if (name === "execute")         return handleExecute(args ?? {});
  if (name === "read_file")       return handleReadFile(args ?? {});
  if (name === "upload_artifact") return handleUploadArtifact(args ?? {});
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

let cleaningUp = false;
async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  await cleanupSandboxes().catch(() => {});
  // Also clean local state (stdio process has its own state separate from platform singleton)
  await Promise.all(
    [...state.sandboxes.values()].map(({ id, provider: p }) => p.terminate(id).catch(() => {})),
  );
  state.sandboxes.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => cleanup().finally(() => process.exit(0)));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sandbox-mcp] ready`);
