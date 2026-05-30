/**
 * Tests for inbox-store.mjs — SQLite persistence for the agent inbox.
 *
 * Run: node --test harnesses/inbox-store.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initDb } from "./loop-store.mjs";
import {
  recordApprovalRequested,
  recordApprovalResolved,
  recordIssue,
  resolveItem,
  listItems,
  attentionCount,
  getItem,
} from "./inbox-store.mjs";

// loop-store keeps a single module-level handle, so initDb only takes effect on
// the first call. Initialize once at import time to a throwaway db file.
const DB_PATH = path.join(os.tmpdir(), `inbox-test-${randomUUID().slice(0, 8)}.db`);
initDb(DB_PATH);
test.after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

function uid(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

test("approval round-trip: requested → pending → accepted", () => {
  const id = uid("appr");
  recordApprovalRequested({
    id,
    tool: "pylon_update_issue",
    args: { issue_id: "abc", state: "open" },
    sessionId: "ses_1",
    agent: "General Agent",
    createdAt: Date.now(),
  });

  const pending = getItem(id);
  assert.equal(pending.kind, "approval");
  assert.equal(pending.status, "pending");
  assert.equal(pending.title, "pylon_update_issue");
  assert.equal(pending.sessionId, "ses_1");
  assert.equal(pending.agent, "General Agent");
  assert.deepEqual(pending.args, { issue_id: "abc", state: "open" });
  assert.ok(listItems("attention").some((i) => i.id === id));

  recordApprovalResolved({ id, decision: "accept", args: { issue_id: "abc", state: "waiting_on_customer" } });
  const done = getItem(id);
  assert.equal(done.status, "accepted");
  assert.deepEqual(done.args, { issue_id: "abc", state: "waiting_on_customer" });
  assert.ok(done.resolvedAt > 0);
  assert.ok(listItems("completed").some((i) => i.id === id));
  assert.ok(!listItems("attention").some((i) => i.id === id));
});

test("approval reject stores feedback", () => {
  const id = uid("appr");
  recordApprovalRequested({ id, tool: "delete_branch", args: { name: "main" }, createdAt: Date.now() });
  recordApprovalResolved({ id, decision: "reject", feedback: "never delete main" });
  const done = getItem(id);
  assert.equal(done.status, "rejected");
  assert.equal(done.feedback, "never delete main");
});

test("recordApprovalResolved is a no-op on an already-resolved row", () => {
  const id = uid("appr");
  recordApprovalRequested({ id, tool: "t", args: {}, createdAt: Date.now() });
  recordApprovalResolved({ id, decision: "accept" });
  recordApprovalResolved({ id, decision: "reject", feedback: "late" });
  const done = getItem(id);
  assert.equal(done.status, "accepted");
  assert.equal(done.feedback, null);
});

test("issue round-trip: open → resolved", () => {
  const id = uid("iss");
  recordIssue({ id, title: "Pylon API key missing", body: "Add PYLON_API_KEY to secrets.", sessionId: "ses_2", agent: "General Agent", createdAt: Date.now() });

  const open = getItem(id);
  assert.equal(open.kind, "issue");
  assert.equal(open.status, "open");
  assert.equal(open.body, "Add PYLON_API_KEY to secrets.");
  assert.ok(listItems("attention").some((i) => i.id === id));

  assert.equal(resolveItem(id, "done"), true);
  const done = getItem(id);
  assert.equal(done.status, "resolved");
  assert.equal(done.feedback, "done");
  assert.ok(listItems("completed").some((i) => i.id === id));
});

test("resolveItem returns false for missing/already-resolved", () => {
  assert.equal(resolveItem("iss_missing"), false);
  const id = uid("appr");
  recordApprovalRequested({ id, tool: "t", args: {}, createdAt: Date.now() });
  recordApprovalResolved({ id, decision: "accept" });
  // can't resolve an accepted approval into 'resolved'
  assert.equal(resolveItem(id), false);
});

test("attentionCount counts pending + open only", () => {
  const before = attentionCount();
  recordApprovalRequested({ id: uid("appr"), tool: "t", args: {}, createdAt: Date.now() });
  recordIssue({ id: uid("iss"), title: "x", createdAt: Date.now() });
  assert.equal(attentionCount(), before + 2);
});

test("listItems newest first", () => {
  const a = uid("iss");
  recordIssue({ id: a, title: "old", createdAt: 1000 });
  const b = uid("iss");
  recordIssue({ id: b, title: "new", createdAt: 2_000_000_000_000 });
  const all = listItems("all");
  assert.ok(all.findIndex((i) => i.id === b) < all.findIndex((i) => i.id === a));
});
