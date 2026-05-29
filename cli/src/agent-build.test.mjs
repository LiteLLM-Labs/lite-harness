import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentDef, autoName } from "./agent-build.mjs";

test("autoName: first few words, sanitised, with fallback", () => {
  assert.equal(autoName("triage my email inbox daily"), "triage my email");
  assert.equal(autoName("   "), "agent");
});

test("buildAgentDef: mirrors /v1/agents fields + cadence", () => {
  const def = buildAgentDef({ task: "DM new profile viewers", cadence: "1h", name: "DM bot", model: "claude-opus-4-8" });
  assert.deepEqual(Object.keys(def).sort(), ["cadence", "model", "name", "system", "tools"]);
  assert.equal(def.name, "DM bot");
  assert.equal(def.model, "claude-opus-4-8");
  assert.equal(def.cadence, "1h");
  assert.match(def.system, /DM new profile viewers/);
  assert.deepEqual(def.tools, [{ type: "agent_toolset_20260401" }]);
});

test("buildAgentDef: defaults name + model + cadence", () => {
  const def = buildAgentDef({ task: "watch CI and fix flaky tests" });
  assert.ok(def.name.length > 0);
  assert.equal(def.model, "claude-sonnet-4-6");
  assert.equal(def.cadence, "none");
});

test("buildAgentDef: empty task throws", () => {
  assert.throws(() => buildAgentDef({ task: "" }), /task is required/);
});

test("buildAgentDef: payload survives JSON round-trip (newlines escaped)", () => {
  const def = buildAgentDef({ task: "do a thing", cadence: "daily" });
  const wire = JSON.stringify(def);
  assert.ok(!wire.includes("\n"), "stringified payload is single-line for /agent save");
  assert.deepEqual(JSON.parse(wire), def);
});
