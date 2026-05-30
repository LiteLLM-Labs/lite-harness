/**
 * Sandbox tools — E2B and Daytona providers, platform-mode delegation.
 *
 * Shared between the platform MCP (all harnesses get it via PLATFORM_MCP_URL)
 * and the opencode stdio MCP (harnesses/opencode/sandbox-mcp.mjs, which is now
 * a thin wrapper around this module).
 *
 * Design: dependency-injectable handlers via createHandlers(). The module-level
 * singleton (built from process.env) is registered in mcp/tools.mjs so every
 * harness that gets PLATFORM_MCP_URL automatically has sandbox tools.
 */

import { buildBackend, VAULT_DB_PATH } from "../harnesses/vault-backend.mjs";
import { createRequire } from "node:module";

const requireFromHarnesses = createRequire(new URL("../harnesses/package.json", import.meta.url));

async function importE2b() {
  try {
    return await import("e2b");
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return requireFromHarnesses("e2b");
  }
}

export const SANDBOX_TIMEOUT_MS = 1_800_000; // 30 min idle keepalive
export const EXECUTE_TIMEOUT_MS = 180_000;   // 3 min per command
export const READ_FILE_MAX_BYTES = 256 * 1024;

// ── Provider base class ───────────────────────────────────────────────────────

export class SandboxProvider {
  get providerName() { return "unknown"; }
  async create(_name) { throw new Error("not implemented"); }
  async execute(_id, _cmd) { throw new Error("not implemented"); }
  async readFile(_id, _path) { throw new Error("not implemented"); }
  async readBase64(_id, _path) { throw new Error("not implemented"); }
  async writeFile(_id, _path, _content) { throw new Error("not implemented"); }
  async terminate(_id) {}
}

// ── E2B provider ──────────────────────────────────────────────────────────────

export class E2bProvider extends SandboxProvider {
  get providerName() { return "e2b"; }

  constructor(apiKey, template, { vaultUrl, vaultProxyToken } = {}) {
    super();
    this._apiKey         = apiKey;
    this._template       = template;
    this._vaultUrl       = vaultUrl;
    this._vaultProxyToken = vaultProxyToken;
  }

  _proxyUrl() {
    if (!this._vaultUrl) return undefined;
    try {
      const u = new URL(this._vaultUrl);
      if (this._vaultProxyToken) { u.username = "x"; u.password = this._vaultProxyToken; }
      return u.toString();
    } catch { return this._vaultUrl; }
  }

  _buildEnvs() {
    const envs = {};
    const proxy = this._proxyUrl();
    if (proxy) { envs.HTTPS_PROXY = proxy; envs.HTTP_PROXY = proxy; }
    return envs;
  }

  async create(_name, getVaultEnvs) {
    const { Sandbox } = await importE2b();
    const vaultEnvs = getVaultEnvs ? await getVaultEnvs() : {};
    const sandbox = await Sandbox.create(this._template, {
      apiKey: this._apiKey,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      envs: { ...this._buildEnvs(), ...vaultEnvs },
    });
    return { id: sandbox.sandboxId, display: `${sandbox.sandboxId} (${this._template})` };
  }

  async execute(id, cmd) {
    const { Sandbox } = await importE2b();
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    let result;
    try {
      result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
    } catch (e) {
      const out = (e.stdout ?? "") + (e.stderr ?? "");
      if (out) return `${out}\n[exit 1]`;
      throw e;
    }
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    return result.exitCode !== 0 ? `${out}\n[exit ${result.exitCode}]` : out;
  }

  async readFile(id, path) {
    const { Sandbox } = await importE2b();
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    return sandbox.files.read(path);
  }

  async readBase64(id, path) {
    const { Sandbox } = await importE2b();
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    const bytes = await sandbox.files.read(path, { format: "bytes" });
    return Buffer.from(bytes).toString("base64");
  }

  async writeFile(id, path, content) {
    const { Sandbox } = await importE2b();
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    await sandbox.files.write(path, content);
  }

  async terminate(id) {
    const { Sandbox } = await importE2b();
    await Sandbox.kill(id, { apiKey: this._apiKey });
  }
}

// ── Daytona provider ──────────────────────────────────────────────────────────

export class DaytonaProvider extends SandboxProvider {
  get providerName() { return "daytona"; }

  constructor(apiKey, apiUrl, snapshot, image, { vaultUrl, vaultProxyToken } = {}) {
    super();
    this._apiKey          = apiKey;
    this._apiUrl          = apiUrl;
    this._snapshot        = snapshot;
    this._image           = image;
    this._vaultUrl        = vaultUrl;
    this._vaultProxyToken = vaultProxyToken;
    this._client          = null;
  }

  async _getClient() {
    if (!this._client) {
      let mod;
      try {
        mod = await import("@daytona/sdk");
      } catch {
        throw new Error(
          "@daytona/sdk not installed. Run: npm install @daytona/sdk\n" +
          "Note: Daytona is an optional dependency not included in the Docker image.",
        );
      }
      this._client = new mod.Daytona({
        apiKey: this._apiKey,
        ...(this._apiUrl ? { apiUrl: this._apiUrl } : {}),
      });
    }
    return this._client;
  }

  _buildEnvVars() {
    const envVars = {};
    if (this._vaultUrl) {
      try {
        const u = new URL(this._vaultUrl);
        if (this._vaultProxyToken) { u.username = "x"; u.password = this._vaultProxyToken; }
        envVars.HTTPS_PROXY = u.toString();
        envVars.HTTP_PROXY  = u.toString();
      } catch {}
    }
    return envVars;
  }

  async create(_name, getVaultEnvs) {
    const daytona = await this._getClient();
    const vaultEnvs = getVaultEnvs ? await getVaultEnvs() : {};
    const envVars = { ...this._buildEnvVars(), ...vaultEnvs };
    const opts = { envVars, autoStopInterval: 0 };
    const sandbox = this._image
      ? await daytona.create({ ...opts, image: this._image }, { timeout: 120 })
      : await daytona.create({ ...opts, snapshot: this._snapshot }, { timeout: 120 });
    return { id: sandbox.id, display: sandbox.id };
  }

  async execute(id, cmd) {
    const daytona = await this._getClient();
    const sandbox = await daytona.get(id);
    const result  = await sandbox.process.executeCommand(
      cmd, undefined, undefined, Math.ceil(EXECUTE_TIMEOUT_MS / 1000),
    );
    const out = result.result ?? "";
    return result.exitCode !== 0 ? `${out}\n[exit ${result.exitCode}]`.trimStart() : out;
  }

  async readFile(id, path) {
    const daytona = await this._getClient();
    const sandbox = await daytona.get(id);
    const buf = await sandbox.fs.downloadFile(path);
    return buf.toString("utf-8");
  }

  async readBase64(id, path) {
    const daytona = await this._getClient();
    const sandbox = await daytona.get(id);
    const buf = await sandbox.fs.downloadFile(path);
    return buf.toString("base64");
  }

  async writeFile(id, path, content) {
    const daytona = await this._getClient();
    const sandbox = await daytona.get(id);
    await sandbox.fs.uploadFile(path, Buffer.from(content, "utf-8"));
  }

  async terminate(id) {
    const daytona = await this._getClient();
    const sandbox = await daytona.get(id);
    await daytona.delete(sandbox);
  }
}

// ── Provider factory ──────────────────────────────────────────────────────────

/**
 * Build a direct-mode provider from a config object (not process.env directly).
 * Returns { provider } or { error: string }.
 */
export function buildProvider(config = {}) {
  const {
    sandboxProvider = "",
    e2bApiKey, e2bTemplate = "base",
    daytonaApiKey, daytonaApiUrl, daytonaSnapshot, daytonaImage,
    vaultUrl, vaultProxyToken,
  } = config;

  const prov = sandboxProvider.toLowerCase();

  if (prov === "e2b" || (!prov && e2bApiKey)) {
    if (!e2bApiKey) return { error: "E2B_API_KEY not set" };
    return { provider: new E2bProvider(e2bApiKey, e2bTemplate, { vaultUrl, vaultProxyToken }) };
  }
  if (prov === "daytona" || (!prov && daytonaApiKey)) {
    if (!daytonaApiKey) return { error: "DAYTONA_API_KEY not set" };
    return { provider: new DaytonaProvider(daytonaApiKey, daytonaApiUrl, daytonaSnapshot, daytonaImage, { vaultUrl, vaultProxyToken }) };
  }
  return {
    error:
      "No sandbox provider configured. Set one of:\n" +
      "  E2B_API_KEY      — use E2B (optionally SANDBOX_PROVIDER=e2b)\n" +
      "  DAYTONA_API_KEY  — use Daytona (optionally SANDBOX_PROVIDER=daytona)\n" +
      "Or enable platform mode with LAP_PLATFORM_MODE=1.",
  };
}

/** Read sandbox config from process.env. */
export function readEnvConfig() {
  return {
    platformMode:     !!process.env.LAP_PLATFORM_MODE,
    base:             process.env.LAP_BASE_URL,
    envSessionId:     process.env.SESSION_ID,
    token:            process.env.LAP_AUTH_TOKEN ?? process.env.MASTER_KEY,
    e2bApiKey:        process.env.E2B_API_KEY,
    e2bTemplate:      process.env.E2B_TEMPLATE || "base",
    daytonaApiKey:    process.env.DAYTONA_API_KEY,
    daytonaApiUrl:    process.env.DAYTONA_API_URL,
    daytonaSnapshot:  process.env.DAYTONA_SNAPSHOT,
    daytonaImage:     process.env.DAYTONA_IMAGE,
    vaultUrl:         process.env.VAULT_URL,
    vaultProxyToken:  process.env.VAULT_PROXY_TOKEN,
    sandboxProvider:  (process.env.SANDBOX_PROVIDER || "").toLowerCase(),
  };
}

// ── State factory ─────────────────────────────────────────────────────────────

export function createState() {
  return {
    sandboxes: new Map(),         // name → { id: string, provider: SandboxProvider }
    sandboxSessionIds: new Map(), // name → session_id (platform mode)
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const SANDBOX_TOOL_DEFINITIONS = [
  {
    name: "sandbox_provision",
    description:
      "Provision a new sandbox environment (E2B or Daytona). Returns a confirmation when ready. " +
      "In platform mode (LAP_PLATFORM_MODE=1), pass session_id — find it in the " +
      "<lap_session_id> tag in your context. In direct mode, session_id is ignored.",
    inputSchema: {
      type: "object",
      properties: {
        name:       { type: "string", description: "Label for the sandbox (use 'main' if unsure)." },
        session_id: { type: "string", description: "LAP session ID — platform mode only." },
      },
      required: ["name"],
    },
  },
  {
    name: "sandbox_execute",
    description: "Execute a shell command inside a provisioned sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        cmd:          { type: "string" },
      },
      required: ["sandbox_name", "cmd"],
    },
  },
  {
    name: "sandbox_read_file",
    description: "Read a file from a provisioned sandbox and return its text content.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        path:         { type: "string" },
        session_id:   { type: "string", description: "LAP session ID — platform mode only." },
      },
      required: ["sandbox_name", "path"],
    },
  },
  {
    name: "sandbox_upload_artifact",
    description:
      "Upload a file from a sandbox to durable storage, get a presigned URL (7-day TTL). " +
      "Use for screenshots, CSVs, PDFs — do NOT use external file hosts.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: { type: "string" },
        path:         { type: "string", description: "Absolute path inside the sandbox." },
        name:         { type: "string", description: "Optional artifact filename." },
        session_id:   { type: "string", description: "LAP session ID — required." },
      },
      required: ["sandbox_name", "path"],
    },
  },
];

// ── MIME helpers ──────────────────────────────────────────────────────────────

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

function textResult(text, isError = false) {
  const r = { content: [{ type: "text", text }] };
  if (isError) r.isError = true;
  return r;
}

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Create bound sandbox tool handlers.
 *
 * @param {object} opts
 * @param {object}            opts.config        — from readEnvConfig() or test override
 * @param {object}            opts.state         — from createState()
 * @param {SandboxProvider|null} opts.provider   — direct-mode provider (null in platform mode)
 * @param {string|null}       opts.providerError — set when provider failed to init
 * @param {Function}          opts.getVaultEnvs  — async () => Record<string,string>
 * @param {Function}          [opts.fetchFn]     — injectable fetch (tests pass a mock)
 * @returns {{ handleProvision, handleExecute, handleReadFile, handleUploadArtifact }}
 */
export function createHandlers({ config, state, provider, providerError, getVaultEnvs, fetchFn = fetch }) {
  const { platformMode, base, token } = config;

  async function handleProvision({ name, session_id: callSid }) {
    if (platformMode) {
      const sid = config.envSessionId || callSid;
      const missing = [];
      if (!base)  missing.push("LAP_BASE_URL   — platform base URL");
      if (!token) missing.push("LAP_AUTH_TOKEN — platform auth token");
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
        const res = await fetchFn(`${base}/api/v1/managed_agents/sessions/${sid}/sandbox/provision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name }),
        });
        const json = await res.json();
        if (!res.ok) return textResult(`provision failed: ${json.error ?? `HTTP ${res.status}`}`, true);
        if (callSid) state.sandboxSessionIds.set(name, callSid);
        return textResult(json.message ?? "sandbox provisioned");
      } catch (e) {
        return textResult(`provision error: ${e.message}`, true);
      }
    }

    if (providerError) {
      return textResult(
        `provision failed: ${providerError}\n` +
        "Or set LAP_PLATFORM_MODE=1 with LAP_BASE_URL + LAP_AUTH_TOKEN + SESSION_ID.",
        true,
      );
    }
    const existing = state.sandboxes.get(name);
    if (existing) {
      try { await existing.provider.terminate(existing.id); } catch {}
    }
    try {
      const { id, display } = await provider.create(name, getVaultEnvs);
      state.sandboxes.set(name, { id, provider });
      return textResult(`sandbox "${name}" ready (${display})`);
    } catch (e) {
      return textResult(`provision error: ${e.message}`, true);
    }
  }

  async function handleExecute({ sandbox_name, cmd }) {
    if (platformMode) {
      const sid = config.envSessionId || state.sandboxSessionIds.get(sandbox_name);
      if (!sid) return textResult(`execute failed: no session_id for sandbox "${sandbox_name}"`, true);
      try {
        const res = await fetchFn(`${base}/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sandbox_name, cmd }),
        });
        const json = await res.json();
        if (!res.ok) return textResult(`execute failed: ${json.error ?? `HTTP ${res.status}`}`, true);
        return textResult(json.output ?? "");
      } catch (e) {
        return textResult(`execute error: ${e.message}`, true);
      }
    }

    const entry = state.sandboxes.get(sandbox_name);
    if (!entry) return textResult(`execute failed: no sandbox "${sandbox_name}" — call sandbox_provision first`, true);
    try {
      const out = await entry.provider.execute(entry.id, cmd);
      return textResult(out);
    } catch (e) {
      return textResult(`execute error: ${e.message}`, true);
    }
  }

  async function handleReadFile({ sandbox_name, path, session_id: callSid }) {
    if (platformMode) {
      const sid = config.envSessionId || callSid || state.sandboxSessionIds.get(sandbox_name);
      if (!sid) return textResult(`read_file failed: no session_id`, true);
      try {
        const res = await fetchFn(`${base}/api/v1/managed_agents/sessions/${sid}/sandbox/read-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sandbox_name, path }),
        });
        const json = await res.json();
        if (!res.ok) return textResult(`read_file failed: ${json.error ?? `HTTP ${res.status}`}`, true);
        return textResult(json.content ?? "");
      } catch (e) {
        return textResult(`read_file error: ${e.message}`, true);
      }
    }

    const entry = state.sandboxes.get(sandbox_name);
    if (!entry) return textResult(`read_file failed: no sandbox "${sandbox_name}" — call sandbox_provision first`, true);
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

  async function handleUploadArtifact({ sandbox_name, path, name: artifactName, session_id: callSid }) {
    const sid = config.envSessionId ?? callSid;
    if (!sid)  return textResult("upload_artifact failed: no session_id", true);
    if (!base) return textResult("upload_artifact failed: LAP_BASE_URL not set", true);

    const fname = artifactName || path.split("/").pop() || "artifact";
    let content;
    try {
      if (platformMode) {
        const res = await fetchFn(`${base}/api/v1/managed_agents/sessions/${sid}/sandbox/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ sandbox_name, cmd: `base64 -w0 ${JSON.stringify(path)}` }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        content = (json.output ?? "").trim();
      } else {
        const entry = state.sandboxes.get(sandbox_name);
        if (!entry) throw new Error(`no sandbox "${sandbox_name}" — call sandbox_provision first`);
        content = await entry.provider.readBase64(entry.id, path);
      }
    } catch (e) {
      return textResult(`upload_artifact error reading ${path}: ${e.message}`, true);
    }

    if (!content) return textResult(`upload_artifact failed: ${path} is empty or unreadable`, true);
    const size = Buffer.from(content, "base64").length;
    try {
      const res = await fetchFn(`${base}/api/v1/managed_agents/sessions/${sid}/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: fname, mime_type: mimeForPath(fname), content, size }),
      });
      const json = await res.json();
      if (!res.ok) return textResult(`upload_artifact failed: ${json.error ?? `HTTP ${res.status}`}`, true);
      return textResult(json.url ?? JSON.stringify(json));
    } catch (e) {
      return textResult(`upload_artifact error: ${e.message}`, true);
    }
  }

  return { handleProvision, handleExecute, handleReadFile, handleUploadArtifact };
}

// ── Module-level singleton (platform MCP) ────────────────────────────────────

let _singleton = null;

function getSingleton() {
  if (_singleton) return _singleton;

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
  } catch {}

  const getVaultEnvs = async () => {
    if (!_vaultBackend) return {};
    try {
      const all = await _vaultBackend.getAll();
      // Strip "owner_id:" prefix so env vars arrive as plain KEY_NAME inside the sandbox.
      const out = {};
      for (const [k, v] of Object.entries(all)) {
        const colon = k.indexOf(":");
        out[colon >= 0 ? k.slice(colon + 1) : k] = v;
      }
      return out;
    } catch { return {}; }
  };

  _singleton = createHandlers({ config, state, provider, providerError, getVaultEnvs });
  _singleton._state = state; // exposed for cleanup
  _singleton._provider = provider;
  return _singleton;
}

/**
 * Register sandbox tools into the platform MCP tool registry.
 * Only registers when a sandbox provider is configured or platform mode is on.
 * Safe to call multiple times — no-op after first call.
 *
 * @param {Function} registerTool — the platform MCP registerTool function
 */
export function registerSandboxTools(registerTool) {
  const config = readEnvConfig();
  const sandboxAvailable =
    config.platformMode || config.e2bApiKey || config.daytonaApiKey;

  if (!sandboxAvailable) return;

  const { handleProvision, handleExecute, handleReadFile, handleUploadArtifact } = getSingleton();

  const [defProvision, defExecute, defReadFile, defUpload] = SANDBOX_TOOL_DEFINITIONS;

  registerTool(defProvision, async (args) => {
    const r = await handleProvision(args);
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(text);
    return { message: text };
  });

  registerTool(defExecute, async (args) => {
    const r = await handleExecute(args);
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(text);
    return { output: text };
  });

  registerTool(defReadFile, async (args) => {
    const r = await handleReadFile(args);
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(text);
    return { content: text };
  });

  registerTool(defUpload, async (args) => {
    const r = await handleUploadArtifact(args);
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(text);
    return { url: text };
  });
}

/**
 * Cleanup all in-process sandboxes. Called on shutdown.
 */
export async function cleanupSandboxes() {
  if (!_singleton) return;
  const state = _singleton._state;
  await Promise.all(
    [...state.sandboxes.values()].map(({ id, provider }) => provider.terminate(id).catch(() => {})),
  );
  state.sandboxes.clear();
}
