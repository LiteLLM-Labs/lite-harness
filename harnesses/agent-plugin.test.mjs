/**
 * Tests for agent-plugin.mjs — pure helpers + routing.
 *
 * Covers everything that doesn't touch SQLite: cadence parsing, command
 * splitting, record validation (mirrors the /v1/agents body), invocation
 * prompt, and match/route behaviour. The DB-backed save path is exercised by
 * the local save roundtrip when better-sqlite3 is available.
 *
 * Run: node --test harnesses/agent-plugin.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCadence,
  parseAgentCommand,
  buildAgentRecord,
  invocationPrompt,
  AgentPlugin,
} from "./agent-plugin.mjs";

test("parseCadence: units and keywords", () => {
  assert.equal(parseCadence("30s"), 30);
  assert.equal(parseCadence("5m"), 300);
  assert.equal(parseCadence("1h"), 3600);
  assert.equal(parseCadence("daily"), 86400);
  assert.equal(parseCadence("weekly"), 604800);
});

test("parseCadence: on-demand markers and junk → null", () => {
  assert.equal(parseCadence("none"), null);
  assert.equal(parseCadence("on-demand"), null);
  assert.equal(parseCadence(""), null);
  assert.equal(parseCadence(null), null);
  assert.equal(parseCadence("whenever"), null);
});

test("parseAgentCommand: subcommands", () => {
  assert.equal(parseAgentCommand("/agent list").sub, "list");
  assert.deepEqual(parseAgentCommand("/agent status abc").args, ["abc"]);
  assert.equal(parseAgentCommand("/agent").sub, "");
});

test("buildAgentRecord: fields mirror /v1/agents + cadence", () => {
  const rec = buildAgentRecord({
    name: "LinkedIn DM",
    model: "claude-opus-4-8",
    system: "DM new profile viewers to book a call.",
    tools: [{ type: "agent_toolset_20260401" }],
    cadence: "1h",
  });
  assert.deepEqual(Object.keys(rec).sort(), [
    "cadence",
    "intervalSeconds",
    "model",
    "name",
    "system",
    "tools",
  ]);
  assert.equal(rec.intervalSeconds, 3600);
  assert.equal(rec.cadence, "1h");
});

test("buildAgentRecord: defaults model + tools, on-demand cadence", () => {
  const rec = buildAgentRecord({ name: "x", system: "do x", cadence: "none" });
  assert.ok(rec.model.length > 0);
  assert.deepEqual(rec.tools, [{ type: "agent_toolset_20260401" }]);
  assert.equal(rec.cadence, null);
  assert.equal(rec.intervalSeconds, null);
});

test("buildAgentRecord: missing required fields throw", () => {
  assert.throws(() => buildAgentRecord({ system: "y" }), /missing 'name'/);
  assert.throws(() => buildAgentRecord({ name: "x" }), /missing 'system'/);
});

test("buildAgentRecord: unparseable cadence throws", () => {
  assert.throws(() => buildAgentRecord({ name: "x", system: "y", cadence: "soon" }), /unknown cadence/);
});

test("invocationPrompt includes name and system", () => {
  const p = invocationPrompt({ name: "Bot", system: "do the thing" });
  assert.match(p, /Bot/);
  assert.match(p, /do the thing/);
});

test("matches only /agent commands", () => {
  const p = new AgentPlugin();
  assert.equal(p.matches("/agent list"), true);
  assert.equal(p.matches("/agent save {}"), true);
  assert.equal(p.matches("hello there"), false);
});

test("save with invalid JSON surfaces an error, not a crash", () => {
  const p = new AgentPlugin();
  const out = { texts: [], errors: [], done: 0 };
  const em = { text: (s) => out.texts.push(s), error: (m) => out.errors.push(m), done: () => out.done++ };
  p.handle("/agent save {not json", { sessionId: "s1" }, em);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /invalid JSON/);
});
