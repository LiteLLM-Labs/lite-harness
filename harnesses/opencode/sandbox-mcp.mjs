#!/usr/bin/env node
/**
 * Sandbox MCP server — supports E2B and Daytona via a provider abstraction.
 *
 * Mode selection (LAP_PLATFORM_MODE env var):
 *   unset (default) — direct mode: provisions sandboxes via the configured provider
 *   LAP_PLATFORM_MODE=1 — platform mode: delegates to the LAP platform API
 *
 * Provider selection in direct mode (SANDBOX_PROVIDER env var):
 *   SANDBOX_PROVIDER=e2b     — use E2B (requires E2B_API_KEY)
 *   SANDBOX_PROVIDER=daytona — use Daytona (requires DAYTONA_API_KEY)
 *   unset                    — auto-detect: E2B if E2B_API_KEY set, else Daytona
 *
 * Direct mode env vars:
 *   E2B:     E2B_API_KEY (required), E2B_TEMPLATE (optional, default: "base")
 *   Daytona: DAYTONA_API_KEY (required), DAYTONA_API_URL (optional),
 *            DAYTONA_SNAPSHOT (optional), DAYTONA_IMAGE (optional)
 *   Both:    VAULT_URL, VAULT_PROXY_TOKEN (optional — credential proxy)
 *
 * Platform mode env vars (LAP_PLATFORM_MODE=1):
 *   LAP_BASE_URL (required), LAP_AUTH_TOKEN or MASTER_KEY (required),
 *   SESSION_ID (required, or pass session_id per provision call)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { buildBackend, VAULT_DB_PATH } from "../vault-backend.mjs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SandboxProvider, E2bProvider, DaytonaProvider, buildDirectProvider as _buildDirectProvider, SANDBOX_TIMEOUT_MS, EXECUTE_TIMEOUT_MS } from "../sandbox-provider.mjs";

// ── Config ────────────────────────────────────────────────────────────────────
const PLATFORM_MODE    = !!process.env.LAP_PLATFORM_MODE;
const BASE             = process.env.LAP_BASE_URL;
const ENV_SESSION_ID   = process.env.SESSION_ID;
const TOKEN            = process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY;
const E2B_API_KEY      = process.env.E2B_API_KEY;
const E2B_TEMPLATE     = process.env.E2B_TEMPLATE || "base";
const DAYTONA_API_KEY  = process.env.DAYTONA_API_KEY;
const DAYTONA_API_URL  = process.env.DAYTONA_API_URL;
const DAYTONA_SNAPSHOT = process.env.DAYTONA_SNAPSHOT;
const DAYTONA_IMAGE    = process.env.DAYTONA_IMAGE;
const VAULT_URL        = process.env.VAULT_URL;
const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
const SANDBOX_PROVIDER_ENV = (process.env.SANDBOX_PROVIDER || "").toLowerCase();

// Vault backend — reads secrets stored by VaultPlugin and injects at provision time.
// Graceful: if better-sqlite3 isn't installed yet, vault injection is silently skipped.
let _vaultBackend = null;
try {
  _vaultBackend = buildBackend(TOKEN, VAULT_DB_PATH);
  console.error(`[sandbox-mcp] vault ready: ${VAULT_DB_PATH} token=${TOKEN ? "set" : "unset"}`);
} catch (e) {
  console.error(`[sandbox-mcp] vault unavailable (${VAULT_DB_PATH}): ${e.message}`);
}

async function getVaultEnvs() {
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
}

const { provider: directProvider, error: providerError } = PLATFORM_MODE
  ? { provider: null, error: null }
  : _buildDirectProvider();

const MODE = PLATFORM_MODE ? "platform" : (directProvider?.providerName ?? "none");
console.error(`[sandbox-mcp] mode=${PLATFORM_MODE ? "platform" : "direct"} provider=${MODE} vault=${VAULT_URL ? "set" : "none"}`);

// ── State ─────────────────────────────────────────────────────────────────────
// Direct mode: name → { id: string, provider: SandboxProvider }
const sandboxes = new Map();
// Platform mode: name → session_id used to provision
const sandboxSessionIds = new Map();

// ── MCP tools ─────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "opencode-sandbox", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "provision",
    description:
      "Provision a new sandbox environment. Returns a confirmation when ready. " +
      "In platform mode (LAP_PLATFORM_MODE=1), pass session_id — find it in the " +
      "<lap_session_id> tag in your context. In direct mode, session_id is ignored.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label for the sandbox (use 'main' if unsure)." },
        session_id: { type: "string", description: "LAP session ID — platform mode only." },
      },
      required: ["name"],
    },
  },
  {
    name: "execute",
    description: "Execute a shell command inside a provisioned sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        cmd: { type: "string" },
      },
      required: ["sandbox_name", "cmd"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from a provisioned sandbox and return its text content.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        path: { type: "string" },
        session_id: { type: "string", description: "LAP session ID — platform mode only." },
      },
      required: ["sandbox_name", "path"],
    },
  },
  {
    name: "upload_artifact",
    description:
      "Upload a file from a sandbox to durable storage, get a presigned URL (7-day TTL). " +
      "Use for screenshots, CSVs, PDFs — do NOT use external file hosts.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        path: { type: "string", description: "Absolute path inside the sandbox." },
        name: { type: "string", description: "Optional artifact filename." },
        session_id: { type: "string", description: "LAP session ID — required." },
      },
      required: ["sandbox_name", "path"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool handlers ─────────────────────────────────────────────────────────────
function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function handleProvision({ name, session_id: callSid }) {
  if (PLATFORM_MODE) {
    const sid = ENV_SESSION_ID || callSid;
    const missing = [];
    if (!BASE)  missing.push("LAP_BASE_URL   — platform base URL");
    if (!TOKEN) missing.push("LAP_AUTH_TOKEN — platform auth token");
    if (!sid)   missing.push("SESSION_ID     — your LAP session ID (or pass session_id)");
    if (missing.length) {
      return textResult(
        "provision failed: platform mode (LAP_PLATFORM_MODE=1) requires:\n" +
        missing.map(s => `  ${s}`).join("\n") + "\n" +
        "Or unset LAP_PLATFORM_MODE to use direct provider mode.",
        true,
      );
    }
    try {
      const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
      if (callSid) sandboxSessionIds.set(name, callSid);
      return textResult(json.message ?? "sandbox provisioned");
    } catch (e) {
      return textResult(`provision error: ${e.message}`, true);
    }
  }

  // Direct mode
  if (providerError) {
    return textResult(
      `provision failed: ${providerError}\n` +
      "Or set LAP_PLATFORM_MODE=1 with LAP_BASE_URL + LAP_AUTH_TOKEN + SESSION_ID.",
      true,
    );
  }
  const existing = sandboxes.get(name);
  if (existing) {
    try { await existing.provider.terminate(existing.id); } catch {}
  }
  try {
    const { id, display } = await directProvider.create(name);
    sandboxes.set(name, { id, provider: directProvider });
    console.error(`[sandbox-mcp] provisioned name=${name} provider=${directProvider.providerName} id=${id}`);
    return textResult(`sandbox "${name}" ready (${display})`);
  } catch (e) {
    return textResult(`provision error: ${e.message}`, true);
  }
}

async function handleExecute({ sandbox_name, cmd }) {
  if (PLATFORM_MODE) {
    const sid = ENV_SESSION_ID || sandboxSessionIds.get(sandbox_name);
    if (!sid) return textResult(`execute failed: no session_id for sandbox "${sandbox_name}"`, true);
    try {
      const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sandbox_name, cmd }),
      });
      const json = await res.json();
      if (!res.ok) return textResult(`execute failed: ${json.error ?? `HTTP ${res.status}`}`, true);
      return textResult(json.output ?? "");
    } catch (e) {
      return textResult(`execute error: ${e.message}`, true);
    }
  }

  const entry = sandboxes.get(sandbox_name);
  if (!entry) return textResult(`execute failed: no sandbox "${sandbox_name}" — call provision first`, true);
  try {
    const out = await entry.provider.execute(entry.id, cmd);
    return textResult(out);
  } catch (e) {
    return textResult(`execute error: ${e.message}`, true);
  }
}

const READ_FILE_MAX_BYTES = 256 * 1024;

async function handleReadFile({ sandbox_name, path, session_id: callSid }) {
  if (PLATFORM_MODE) {
    const sid = ENV_SESSION_ID || callSid || sandboxSessionIds.get(sandbox_name);
    if (!sid) return textResult(`read_file failed: no session_id`, true);
    try {
      const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox/read-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sandbox_name, path }),
      });
      const json = await res.json();
      if (!res.ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${res.status}`}`, true);
      return textResult(json.content ?? "");
    } catch (e) {
      return textResult(`read_file error: ${e.message}`, true);
    }
  }

  const entry = sandboxes.get(sandbox_name);
  if (!entry) return textResult(`read_file failed: no sandbox "${sandbox_name}" — call provision first`, true);
  try {
    const content = await entry.provider.readFile(entry.id, path);
    if (content.length > READ_FILE_MAX_BYTES) {
      return textResult(`error: file too large (${content.length} bytes > ${READ_FILE_MAX_BYTES}). Read a smaller slice.`, true);
    }
    return textResult(content);
  } catch (e) {
    return textResult(`read_file error: ${e.message}`, true);
  }
}

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", json: "application/json",
  csv: "text/csv", md: "text/markdown", txt: "text/plain",
  py: "text/x-python", ts: "text/x-typescript", js: "text/x-javascript",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip",
};
function mimeForPath(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function handleUploadArtifact({ sandbox_name, path, name, session_id: callSid }) {
  const sid = ENV_SESSION_ID ?? callSid;
  if (!sid)  return textResult("upload_artifact failed: no session_id", true);
  if (!BASE) return textResult("upload_artifact failed: LAP_BASE_URL not set", true);

  const fname = name || path.split("/").pop() || "artifact";
  let content;
  try {
    if (PLATFORM_MODE) {
      // Shell out to base64 inside the platform sandbox
      const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sandbox_name, cmd: `base64 -w0 ${JSON.stringify(path)}` }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      content = (json.output ?? "").trim();
    } else {
      const entry = sandboxes.get(sandbox_name);
      if (!entry) throw new Error(`no sandbox "${sandbox_name}" — call provision first`);
      content = await entry.provider.readBase64(entry.id, path);
    }
  } catch (e) {
    return textResult(`upload_artifact error reading ${path}: ${e.message}`, true);
  }

  if (!content) return textResult(`upload_artifact failed: ${path} is empty or unreadable`, true);
  const size = Buffer.from(content, "base64").length;
  try {
    const res = await fetch(`${BASE}/api/v1/managed_agents/sessions/${sid}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: fname, mime_type: mimeForPath(fname), content, size }),
    });
    const json = await res.json();
    if (!res.ok) return textResult(`upload_artifact failed: ${json.error ?? `HTTP ${res.status}`}`, true);
    return textResult(json.url ?? JSON.stringify(json));
  } catch (e) {
    return textResult(`upload_artifact error: ${e.message}`, true);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === "provision")       return handleProvision(args ?? {});
  if (name === "execute")         return handleExecute(args ?? {});
  if (name === "read_file")       return handleReadFile(args ?? {});
  if (name === "upload_artifact") return handleUploadArtifact(args ?? {});
  return textResult(`unknown tool: ${name}`, true);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return;
  cleaningUp = true;
  await Promise.all(
    [...sandboxes.values()].map(({ id, provider }) => provider.terminate(id).catch(() => {})),
  );
  sandboxes.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => cleanupAll().finally(() => process.exit(0)));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[sandbox-mcp] ready`);
