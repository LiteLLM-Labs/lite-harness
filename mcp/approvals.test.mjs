/**
 * Tests for approvals.mjs — the human-in-the-loop tool approval store.
 *
 * Run: node --test mcp/approvals.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestApproval,
  listPending,
  getPending,
  acceptApproval,
  rejectApproval,
  setApprovalBroadcaster,
  _reset,
} from "./approvals.mjs";

function reset() {
  _reset();
}

// ── accept ───────────────────────────────────────────────────────────────────

test("acceptApproval resolves with original args", async () => {
  reset();
  const p = requestApproval("save_agent", { agent_name: "bot" });
  const pend = listPending();
  assert.equal(pend.length, 1);
  assert.equal(pend[0].tool, "save_agent");
  assert.deepEqual(pend[0].arguments, { agent_name: "bot" });

  assert.equal(acceptApproval(pend[0].id), true);
  const outcome = await p;
  assert.deepEqual(outcome, { decision: "accept", args: { agent_name: "bot" } });
  assert.equal(listPending().length, 0);
});

test("acceptApproval applies human-edited args", async () => {
  reset();
  const p = requestApproval("pylon_update_issue", { issue_id: "abc", state: "open" });
  const { id } = listPending()[0];
  assert.equal(acceptApproval(id, { issue_id: "abc", state: "waiting_on_customer" }), true);
  const outcome = await p;
  assert.equal(outcome.decision, "accept");
  assert.deepEqual(outcome.args, { issue_id: "abc", state: "waiting_on_customer" });
});

test("acceptApproval ignores non-object edited args (keeps original)", async () => {
  reset();
  const p = requestApproval("t", { a: 1 });
  const { id } = listPending()[0];
  acceptApproval(id, "not-an-object");
  const outcome = await p;
  assert.deepEqual(outcome.args, { a: 1 });
});

// ── reject ───────────────────────────────────────────────────────────────────

test("rejectApproval resolves with feedback", async () => {
  reset();
  const p = requestApproval("delete_branch", { name: "main" });
  const { id } = listPending()[0];
  assert.equal(rejectApproval(id, "never delete main"), true);
  const outcome = await p;
  assert.deepEqual(outcome, { decision: "reject", feedback: "never delete main" });
  assert.equal(listPending().length, 0);
});

test("rejectApproval with no feedback yields empty string", async () => {
  reset();
  const p = requestApproval("t", {});
  const { id } = listPending()[0];
  rejectApproval(id);
  const outcome = await p;
  assert.deepEqual(outcome, { decision: "reject", feedback: "" });
});

// ── unknown ids ──────────────────────────────────────────────────────────────

test("accept/reject unknown id returns false", () => {
  reset();
  assert.equal(acceptApproval("appr_nope"), false);
  assert.equal(rejectApproval("appr_nope"), false);
});

test("getPending returns a public view without internal handles", () => {
  reset();
  requestApproval("t", { x: 1 });
  const { id } = listPending()[0];
  const view = getPending(id);
  assert.deepEqual(Object.keys(view).sort(), ["arguments", "createdAt", "id", "tool"]);
  assert.equal(getPending("missing"), null);
  reset();
});

// ── timeout ──────────────────────────────────────────────────────────────────

test("requestApproval times out into a reject", async () => {
  reset();
  const p = requestApproval("t", {}, { timeoutMs: 20, unref: false });
  const outcome = await p;
  assert.equal(outcome.decision, "reject");
  assert.match(outcome.feedback, /timed out/i);
  assert.equal(listPending().length, 0);
});

// ── broadcaster ──────────────────────────────────────────────────────────────

test("broadcaster receives requested + resolved events", async () => {
  reset();
  const events = [];
  setApprovalBroadcaster((e) => events.push(e));
  const p = requestApproval("t", { a: 1 });
  const { id } = listPending()[0];
  acceptApproval(id);
  await p;
  assert.equal(events[0].type, "tool.approval.requested");
  assert.equal(events[0].id, id);
  assert.deepEqual(events[0].arguments, { a: 1 });
  assert.equal(events[1].type, "tool.approval.resolved");
  assert.equal(events[1].decision, "accept");
  reset();
});
