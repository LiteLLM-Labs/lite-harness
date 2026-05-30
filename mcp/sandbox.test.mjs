/**
 * Tests for mcp/sandbox.mjs
 *
 * Run: node --test mcp/sandbox.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SandboxProvider,
  E2bProvider,
  DaytonaProvider,
  buildProvider,
  createState,
  createHandlers,
  SANDBOX_TOOL_DEFINITIONS,
  READ_FILE_MAX_BYTES,
} from "./sandbox.mjs";

// ── Mock provider ─────────────────────────────────────────────────────────────

class MockProvider extends SandboxProvider {
  get providerName() { return "mock"; }
  constructor() {
    super();
    this.created    = [];
    this.executed   = [];
    this.terminated = [];
    this._nextId    = 0;
  }
  async create(name) {
    const id = `mock-${++this._nextId}`;
    this.created.push({ name, id });
    return { id, display: `mock:${id}` };
  }
  async execute(id, cmd) {
    this.executed.push({ id, cmd });
    return `output of: ${cmd}`;
  }
  async readFile(id, path) {
    if (path === "/big") return "x".repeat(READ_FILE_MAX_BYTES + 1);
    return `contents of ${path}`;
  }
  async readBase64(id, path) {
    return Buffer.from(`base64:${path}`).toString("base64");
  }
  async terminate(id) {
    this.terminated.push(id);
  }
}

function makeHandlers(overrides = {}) {
  const provider = new MockProvider();
  const state    = createState();
  const config   = {
    platformMode: false,
    base: null, envSessionId: null, token: null,
    ...overrides.config,
  };
  const h = createHandlers({
    config,
    state,
    provider,
    providerError: overrides.providerError ?? null,
    getVaultEnvs: async () => ({}),
    fetchFn: overrides.fetchFn ?? (() => { throw new Error("unexpected fetch"); }),
  });
  return { ...h, provider, state };
}

// ── buildProvider ─────────────────────────────────────────────────────────────

test("buildProvider returns E2bProvider when e2bApiKey set", () => {
  const { provider, error } = buildProvider({ e2bApiKey: "key123", e2bTemplate: "base" });
  assert.ok(provider instanceof E2bProvider);
  assert.equal(error, undefined);
});

test("buildProvider returns DaytonaProvider when daytonaApiKey set", () => {
  const { provider, error } = buildProvider({ daytonaApiKey: "dkey" });
  assert.ok(provider instanceof DaytonaProvider);
  assert.equal(error, undefined);
});

test("buildProvider prefers E2B when both keys set", () => {
  const { provider } = buildProvider({ e2bApiKey: "e", daytonaApiKey: "d" });
  assert.ok(provider instanceof E2bProvider);
});

test("buildProvider respects SANDBOX_PROVIDER=daytona override", () => {
  const { provider } = buildProvider({ sandboxProvider: "daytona", daytonaApiKey: "d", e2bApiKey: "e" });
  assert.ok(provider instanceof DaytonaProvider);
});

test("buildProvider returns error when no provider configured", () => {
  const { error, provider } = buildProvider({});
  assert.ok(typeof error === "string");
  assert.equal(provider, undefined);
});

test("buildProvider returns error when SANDBOX_PROVIDER=e2b but no key", () => {
  const { error } = buildProvider({ sandboxProvider: "e2b" });
  assert.match(error, /E2B_API_KEY/);
});

// ── SANDBOX_TOOL_DEFINITIONS ──────────────────────────────────────────────────

test("SANDBOX_TOOL_DEFINITIONS has 4 entries with expected names", () => {
  const names = SANDBOX_TOOL_DEFINITIONS.map(d => d.name);
  assert.deepEqual(names, ["sandbox_provision", "sandbox_execute", "sandbox_read_file", "sandbox_upload_artifact"]);
});

test("each tool definition has name, description, inputSchema", () => {
  for (const def of SANDBOX_TOOL_DEFINITIONS) {
    assert.ok(def.name, "missing name");
    assert.ok(def.description, "missing description");
    assert.ok(def.inputSchema, "missing inputSchema");
  }
});

// ── handleProvision (direct mode) ────────────────────────────────────────────

test("provision creates sandbox and stores in state", async () => {
  const { handleProvision, provider, state } = makeHandlers();
  const r = await handleProvision({ name: "main" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /ready/);
  assert.equal(provider.created.length, 1);
  assert.equal(provider.created[0].name, "main");
  assert.ok(state.sandboxes.has("main"));
});

test("provision replaces existing sandbox (terminates old)", async () => {
  const { handleProvision, provider, state } = makeHandlers();
  await handleProvision({ name: "main" });
  const firstId = [...state.sandboxes.values()][0].id;
  await handleProvision({ name: "main" });
  assert.equal(provider.terminated.length, 1);
  assert.equal(provider.terminated[0], firstId);
  assert.equal(provider.created.length, 2);
});

test("provision returns error when no provider configured", async () => {
  const { handleProvision } = makeHandlers({ providerError: "no provider" });
  const r = await handleProvision({ name: "main" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no provider/);
});

// ── handleExecute (direct mode) ──────────────────────────────────────────────

test("execute runs command in provisioned sandbox", async () => {
  const { handleProvision, handleExecute, provider } = makeHandlers();
  await handleProvision({ name: "main" });
  const r = await handleExecute({ sandbox_name: "main", cmd: "echo hi" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /echo hi/);
  assert.equal(provider.executed.length, 1);
  assert.equal(provider.executed[0].cmd, "echo hi");
});

test("execute fails when sandbox not provisioned", async () => {
  const { handleExecute } = makeHandlers();
  const r = await handleExecute({ sandbox_name: "main", cmd: "ls" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /sandbox_provision/);
});

// ── handleReadFile (direct mode) ─────────────────────────────────────────────

test("read_file returns file contents", async () => {
  const { handleProvision, handleReadFile } = makeHandlers();
  await handleProvision({ name: "main" });
  const r = await handleReadFile({ sandbox_name: "main", path: "/tmp/out.txt" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /\/tmp\/out\.txt/);
});

test("read_file fails when sandbox not provisioned", async () => {
  const { handleReadFile } = makeHandlers();
  const r = await handleReadFile({ sandbox_name: "main", path: "/tmp/x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /sandbox_provision/);
});

test("read_file rejects file exceeding size limit", async () => {
  const { handleProvision, handleReadFile } = makeHandlers();
  await handleProvision({ name: "main" });
  const r = await handleReadFile({ sandbox_name: "main", path: "/big" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /too large/);
});

// ── handleUploadArtifact (direct mode) ───────────────────────────────────────

test("upload_artifact fails without session_id", async () => {
  const { handleProvision, handleUploadArtifact } = makeHandlers({
    config: { base: "http://lap.test" },
  });
  await handleProvision({ name: "main" });
  const r = await handleUploadArtifact({ sandbox_name: "main", path: "/out.png" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /session_id/);
});

test("upload_artifact fails without LAP_BASE_URL", async () => {
  const { handleProvision, handleUploadArtifact } = makeHandlers({
    config: { envSessionId: "ses_abc", base: null },
  });
  await handleProvision({ name: "main" });
  const r = await handleUploadArtifact({ sandbox_name: "main", path: "/out.png" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LAP_BASE_URL/);
});

test("upload_artifact posts base64 and returns url", async () => {
  const fetchLog = [];
  const mockFetch = async (url, opts) => {
    fetchLog.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ url: "https://cdn.example.com/artifact.png" }),
    };
  };
  const { handleProvision, handleUploadArtifact } = makeHandlers({
    config: { envSessionId: "ses_abc", base: "http://lap.test", token: "tok" },
    fetchFn: mockFetch,
  });
  await handleProvision({ name: "main" });
  const r = await handleUploadArtifact({ sandbox_name: "main", path: "/out.png", name: "result.png" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /cdn\.example\.com/);
  assert.equal(fetchLog.length, 1);
  const body = JSON.parse(fetchLog[0].opts.body);
  assert.equal(body.name, "result.png");
  assert.equal(body.mime_type, "image/png");
  assert.ok(body.content.length > 0);
});

test("upload_artifact fails when sandbox not provisioned", async () => {
  const { handleUploadArtifact } = makeHandlers({
    config: { envSessionId: "ses_abc", base: "http://lap.test" },
  });
  const r = await handleUploadArtifact({ sandbox_name: "missing", path: "/out.png" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /sandbox_provision/);
});

// ── Platform mode ─────────────────────────────────────────────────────────────

test("platform provision delegates to LAP API", async () => {
  const fetchLog = [];
  const mockFetch = async (url, opts) => {
    fetchLog.push({ url, opts });
    return { ok: true, json: async () => ({ message: "sandbox provisioned" }) };
  };
  const { handleProvision } = makeHandlers({
    config: {
      platformMode: true,
      base: "http://lap.test",
      token: "tok",
      envSessionId: "ses_xyz",
    },
    fetchFn: mockFetch,
  });
  const r = await handleProvision({ name: "main" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /provisioned/);
  assert.ok(fetchLog[0].url.includes("ses_xyz"));
  assert.ok(fetchLog[0].url.includes("/sandbox/provision"));
});

test("platform provision fails when session_id missing", async () => {
  const { handleProvision } = makeHandlers({
    config: {
      platformMode: true,
      base: "http://lap.test",
      token: "tok",
      envSessionId: null,
    },
  });
  const r = await handleProvision({ name: "main" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /SESSION_ID/);
});

test("platform execute delegates to LAP API", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ output: "hello world" }),
  });
  const { handleExecute } = makeHandlers({
    config: {
      platformMode: true,
      base: "http://lap.test",
      token: "tok",
      envSessionId: "ses_xyz",
    },
    fetchFn: mockFetch,
  });
  const r = await handleExecute({ sandbox_name: "main", cmd: "echo hi" });
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "hello world");
});

test("platform execute fails without session_id for sandbox", async () => {
  const { handleExecute } = makeHandlers({
    config: { platformMode: true, base: "http://lap.test", token: "tok", envSessionId: null },
  });
  const r = await handleExecute({ sandbox_name: "main", cmd: "ls" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /session_id/);
});

// ── createState isolation ─────────────────────────────────────────────────────

test("createState returns independent maps each call", () => {
  const a = createState();
  const b = createState();
  a.sandboxes.set("x", {});
  assert.equal(b.sandboxes.size, 0);
});
