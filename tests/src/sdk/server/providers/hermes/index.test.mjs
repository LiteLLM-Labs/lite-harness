import { test } from "node:test";
import assert from "node:assert/strict";

test("hermes createRuntime throws if HERMES_API_BASE is missing", async () => {
  // Import a fresh copy to avoid the module-level `configured` singleton.
  const mod = await import(
    "../../../../../../src/sdk/server/providers/hermes/index.mjs?ts=" + Date.now()
  );
  assert.throws(
    () => mod.createRuntime({ model: "hermes-3", env: {} }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HERMES_API_BASE/);
      return true;
    },
  );
});

test("hermes createRuntime exposes the model passed in", async () => {
  // Stub out the @openai/agents globals so we don't hit a real server.
  const mod = await import(
    "../../../../../../src/sdk/server/providers/hermes/index.mjs?ts=" + Date.now()
  );
  const runtime = mod.createRuntime({
    model: "nous-hermes2",
    env: { HERMES_API_BASE: "http://localhost:11434" },
  });
  assert.equal(runtime.model, "nous-hermes2");
});

test("hermes setModel updates the model", async () => {
  const mod = await import(
    "../../../../../../src/sdk/server/providers/hermes/index.mjs?ts=" + Date.now()
  );
  const runtime = mod.createRuntime({
    model: "nous-hermes2",
    env: { HERMES_API_BASE: "http://localhost:11434" },
  });
  runtime.setModel("hermes-3");
  assert.equal(runtime.model, "hermes-3");
});

test("hermes setModel ignores falsy values", async () => {
  const mod = await import(
    "../../../../../../src/sdk/server/providers/hermes/index.mjs?ts=" + Date.now()
  );
  const runtime = mod.createRuntime({
    model: "nous-hermes2",
    env: { HERMES_API_BASE: "http://localhost:11434" },
  });
  runtime.setModel(null);
  assert.equal(runtime.model, "nous-hermes2");
});
