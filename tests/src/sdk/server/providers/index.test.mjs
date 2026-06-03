// Tests for the auto-discovery provider registry in ./index.mjs.
//
// Importing the real anthropic/codex provider index.mjs pulls in
// @anthropic-ai/claude-agent-sdk and @openai/agents, but no network is hit at
// import time (only when createRuntime/runTurn actually runs), so the built-in
// providers resolve fine here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProviderMetadata,
  loadProviders,
  resolveProvider,
} from "../../../../../src/sdk/server/providers/index.mjs";

test("resolveProvider('anthropic') resolves to the anthropic module", async () => {
  const mod = await resolveProvider("anthropic");
  assert.equal(mod.id, "anthropic");
  assert.equal(typeof mod.createRuntime, "function");
});

test("anthropic aliases resolve to the same module (case-insensitive)", async () => {
  const anthropic = await resolveProvider("anthropic");
  for (const alias of ["claude", "claude-code", "cc"]) {
    const mod = await resolveProvider(alias);
    assert.equal(mod, anthropic, `alias ${alias} should resolve to anthropic`);
  }
  const upper = await resolveProvider("CLAUDE");
  assert.equal(upper, anthropic, "CLAUDE should resolve case-insensitively");
});

test("resolveProvider('codex') and its 'openai' alias resolve to the codex module", async () => {
  const codex = await resolveProvider("codex");
  assert.equal(codex.id, "codex");
  assert.equal(typeof codex.createRuntime, "function");

  const openai = await resolveProvider("openai");
  assert.equal(openai, codex, "openai alias should resolve to codex");
});

test("resolveProvider('nope') throws with 'unsupported agent'", async () => {
  await assert.rejects(
    () => resolveProvider("nope"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /unsupported agent/);
      return true;
    },
  );
});

test("loadProviders() returns a Map containing anthropic, claude, codex keys", async () => {
  const map = await loadProviders();
  assert.ok(map instanceof Map);
  for (const key of ["anthropic", "claude", "codex"]) {
    assert.ok(map.has(key), `expected map to contain key ${key}`);
  }
});

test("listProviderMetadata() returns one public harness entry per provider", async () => {
  const harnesses = await listProviderMetadata();
  const byId = new Map(harnesses.map((harness) => [harness.id, harness]));

  assert.equal(byId.get("claude-code")?.providerId, "anthropic");
  assert.equal(byId.get("claude-code")?.name, "Claude Code");
  assert.deepEqual(byId.get("claude-code")?.aliases, ["claude-agent", "claude", "claude-code", "cc"]);
  assert.equal("models" in byId.get("claude-code"), false);

  assert.equal(byId.get("codex")?.providerId, "codex");
  assert.equal(byId.get("codex")?.name, "Codex");
  assert.deepEqual(byId.get("codex")?.aliases, ["openai-agents", "openai"]);
  assert.equal("models" in byId.get("codex"), false);
});

test("discovers providers from LITE_HARNESS_PROVIDERS_DIR (fresh import)", async () => {
  // Build a temp extra-providers dir with a single `mock` provider folder.
  const tmpRoot = mkdtempSync(join(tmpdir(), "lh-providers-"));
  const mockDir = join(tmpRoot, "mock");
  mkdirSync(mockDir, { recursive: true });
  writeFileSync(
    join(mockDir, "index.mjs"),
    'export const id = "mock";\nexport function createRuntime() { return {}; }\n',
  );

  // loadProviders caches its registry, so we set the env var and then import a
  // *fresh* copy of index.mjs via a cache-busting query string.
  const prev = process.env.LITE_HARNESS_PROVIDERS_DIR;
  process.env.LITE_HARNESS_PROVIDERS_DIR = tmpRoot;
  try {
    const fresh = await import("../../../../../src/sdk/server/providers/index.mjs?ts=" + Date.now());
    const mod = await fresh.resolveProvider("mock");
    assert.equal(mod.id, "mock");
    assert.equal(typeof mod.createRuntime, "function");
  } finally {
    if (prev === undefined) delete process.env.LITE_HARNESS_PROVIDERS_DIR;
    else process.env.LITE_HARNESS_PROVIDERS_DIR = prev;
  }
});
