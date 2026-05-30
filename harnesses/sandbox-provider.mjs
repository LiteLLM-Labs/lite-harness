/**
 * Reusable sandbox provider abstraction.
 *
 * Exports:
 *   SANDBOX_TIMEOUT_MS  — idle keepalive timeout (30 min)
 *   EXECUTE_TIMEOUT_MS  — per-command timeout (3 min)
 *   SandboxProvider     — abstract base class
 *   E2bProvider         — E2B concrete provider
 *   DaytonaProvider     — Daytona concrete provider
 *   buildDirectProvider — factory that reads env vars and returns { provider } or { error }
 *
 * No static imports — "e2b" and "@daytona/sdk" are imported dynamically inside async methods.
 */

export const SANDBOX_TIMEOUT_MS = 1_800_000; // 30 min idle keepalive
export const EXECUTE_TIMEOUT_MS = 180_000;   // 3 min per command

// ── Provider base class ───────────────────────────────────────────────────────
export class SandboxProvider {
  get providerName() { return "unknown"; }
  /** Create sandbox → { id: string, display: string } */
  async create(_name) { throw new Error("not implemented"); }
  /** Run command → stdout+stderr string */
  async execute(_id, _cmd) { throw new Error("not implemented"); }
  /** Read file text */
  async readFile(_id, _path) { throw new Error("not implemented"); }
  /** Read file as base64 */
  async readBase64(_id, _path) { throw new Error("not implemented"); }
  /** Write text content to a file path inside the sandbox */
  async writeFile(_id, _path, _content) { throw new Error("not implemented"); }
  /** Terminate sandbox */
  async terminate(_id) {}
}

// ── E2B provider ──────────────────────────────────────────────────────────────
export class E2bProvider extends SandboxProvider {
  get providerName() { return "e2b"; }

  constructor(apiKey, template) {
    super();
    this._apiKey   = apiKey;
    this._template = template;
  }

  _buildEnvs() {
    const VAULT_URL = process.env.VAULT_URL;
    const envs = {};
    if (VAULT_URL) {
      const proxyUrl = this._proxyUrl();
      envs.HTTPS_PROXY = proxyUrl;
      envs.HTTP_PROXY  = proxyUrl;
    }
    return envs;
  }

  _proxyUrl() {
    const VAULT_URL = process.env.VAULT_URL;
    const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
    if (!VAULT_URL) return undefined;
    try {
      const u = new URL(VAULT_URL);
      if (VAULT_PROXY_TOKEN) { u.username = "x"; u.password = VAULT_PROXY_TOKEN; }
      return u.toString();
    } catch { return VAULT_URL; }
  }

  async create(name) {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.create(this._template, {
      apiKey: this._apiKey,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      envs: { ...this._buildEnvs() },
    });
    return { id: sandbox.sandboxId, display: `${sandbox.sandboxId} (${this._template})` };
  }

  async execute(id, cmd) {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS); // keepalive
    const result = await sandbox.commands.run(cmd, { timeoutMs: EXECUTE_TIMEOUT_MS });
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    return result.exitCode !== 0 ? `${out}\n[exit ${result.exitCode}]` : out;
  }

  async readFile(id, path) {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    return sandbox.files.read(path);
  }

  async readBase64(id, path) {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    const bytes = await sandbox.files.read(path, { format: "bytes" });
    return Buffer.from(bytes).toString("base64");
  }

  async writeFile(id, path, content) {
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.connect(id, { apiKey: this._apiKey });
    await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
    await sandbox.files.write(path, content);
  }

  async terminate(id) {
    const { Sandbox } = await import("e2b");
    await Sandbox.kill(id, { apiKey: this._apiKey });
  }
}

// ── Daytona provider ──────────────────────────────────────────────────────────
export class DaytonaProvider extends SandboxProvider {
  get providerName() { return "daytona"; }

  constructor(apiKey, apiUrl, snapshot, image) {
    super();
    this._apiKey   = apiKey;
    this._apiUrl   = apiUrl;
    this._snapshot = snapshot;
    this._image    = image;
    this._client   = null;
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
    const VAULT_URL = process.env.VAULT_URL;
    const VAULT_PROXY_TOKEN = process.env.VAULT_PROXY_TOKEN;
    const envVars = {};
    if (VAULT_URL) {
      try {
        const u = new URL(VAULT_URL);
        if (VAULT_PROXY_TOKEN) { u.username = "x"; u.password = VAULT_PROXY_TOKEN; }
        envVars.HTTPS_PROXY = u.toString();
        envVars.HTTP_PROXY  = u.toString();
      } catch {}
    }
    return envVars;
  }

  async create(_name) {
    const daytona = await this._getClient();
    const envVars = { ...this._buildEnvVars() };
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
export function buildDirectProvider() {
  const E2B_API_KEY      = process.env.E2B_API_KEY;
  const E2B_TEMPLATE     = process.env.E2B_TEMPLATE || "base";
  const DAYTONA_API_KEY  = process.env.DAYTONA_API_KEY;
  const DAYTONA_API_URL  = process.env.DAYTONA_API_URL;
  const DAYTONA_SNAPSHOT = process.env.DAYTONA_SNAPSHOT;
  const DAYTONA_IMAGE    = process.env.DAYTONA_IMAGE;
  const SANDBOX_PROVIDER_ENV = (process.env.SANDBOX_PROVIDER || "").toLowerCase();

  if (SANDBOX_PROVIDER_ENV === "e2b" || (!SANDBOX_PROVIDER_ENV && E2B_API_KEY)) {
    if (!E2B_API_KEY) return { error: "E2B_API_KEY not set" };
    return { provider: new E2bProvider(E2B_API_KEY, E2B_TEMPLATE) };
  }
  if (SANDBOX_PROVIDER_ENV === "daytona" || (!SANDBOX_PROVIDER_ENV && DAYTONA_API_KEY)) {
    if (!DAYTONA_API_KEY) return { error: "DAYTONA_API_KEY not set" };
    return { provider: new DaytonaProvider(DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_SNAPSHOT, DAYTONA_IMAGE) };
  }
  return { error: "No sandbox provider configured. Set E2B_API_KEY or DAYTONA_API_KEY." };
}
