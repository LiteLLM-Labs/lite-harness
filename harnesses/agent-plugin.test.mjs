/**
 * Tests for agent-plugin.mjs — pure helpers + interview control flow.
 *
 * These cover everything that doesn't touch SQLite or the network:
 * cadence/command/spec parsing, record validation (mirrors the /v1/agents
 * body), match routing, the question step, and cancel. DB-backed finalize is
 * exercised when better-sqlite3 is available (see agent-store integration).
 *
 * Run: node --test harnesses/agent-plugin.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCadence,
  parseAgentCommand,
  extractSpec,
  buildAgentRecord,
  invocationPrompt,
  AgentPlugin,
} from "./agent-plugin.mjs";

// ── parseCadence ─────────────────────────────────────────────────────────────

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
  assert.equal(parseCadence("once"), null);
  assert.equal(parseCadence(""), null);
  assert.equal(parseCadence(null), null);
  assert.equal(parseCadence("whenever"), null);
});

// ── parseAgentCommand ────────────────────────────────────────────────────────

test("parseAgentCommand: subcommands and free-text", () => {
  assert.equal(parseAgentCommand("/agent list").sub, "list");
  assert.deepEqual(parseAgentCommand("/agent status abc").args, ["abc"]);
  assert.equal(parseAgentCommand("/agent").sub, "");
  const c = parseAgentCommand("/agent do my linkedin dms");
  assert.equal(c.sub, "do");
  assert.equal(c.rest, "do my linkedin dms");
});

// ── extractSpec ──────────────────────────────────────────────────────────────

test("extractSpec: parses an agent-spec fence", () => {
  const txt = 'Here you go:\n```agent-spec\n{"name":"DM bot","system":"dm people"}\n```';
  assert.deepEqual(extractSpec(txt), { name: "DM bot", system: "dm people" });
});

test("extractSpec: parses a json fence too", () => {
  assert.deepEqual(extractSpec('```json\n{"name":"x","system":"y"}\n```'), {
    name: "x",
    system: "y",
  });
});

test("extractSpec: no fence / bad json → null", () => {
  assert.equal(extractSpec("just a question?"), null);
  assert.equal(extractSpec("```agent-spec\nnot json\n```"), null);
});

// ── buildAgentRecord ─────────────────────────────────────────────────────────

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
    "cronExpr",
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

// ── plugin routing + interview ───────────────────────────────────────────────

function fakeEmitter() {
  const out = { texts: [], errors: [], done: 0 };
  return {
    out,
    text: (s) => out.texts.push(s),
    error: (m) => out.errors.push(m),
    done: () => (out.done += 1),
  };
}

test("matches /agent commands, and any text only while building", () => {
  const p = new AgentPlugin();
  const ctx = { sessionId: "s1" };
  assert.equal(p.matches("/agent list", ctx), true);
  assert.equal(p.matches("hello there", ctx), false);
  p._builds.set("s1", { messages: [] });
  assert.equal(p.matches("hello there", ctx), true);
});

test("interview asks a question and keeps the build open", async () => {
  const p = new AgentPlugin();
  const ctx = { sessionId: "s2" };
  p._complete = async () => "Who should it message?"; // stub: no network
  p._builds.set("s2", { messages: [] });

  const em = fakeEmitter();
  await p._step("do my linkedin dms", ctx, em);

  assert.deepEqual(em.out.texts, ["Who should it message?"]);
  assert.equal(em.out.done, 1);
  assert.ok(p._builds.has("s2"), "build stays open until a spec is produced");
});

test("/agent cancel clears an in-progress build", () => {
  const p = new AgentPlugin();
  const ctx = { sessionId: "s3" };
  p._builds.set("s3", { messages: [] });
  const em = fakeEmitter();
  p._manage("cancel", [], ctx, em);
  assert.equal(p._builds.has("s3"), false);
  assert.match(em.out.texts[0], /cancelled/i);
});
