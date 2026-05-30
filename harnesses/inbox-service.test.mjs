/**
 * Tests for inbox-service.mjs — the HTTP route dispatcher + lifecycle wiring.
 *
 * Run: node --test harnesses/inbox-service.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { initDb } from "./loop-store.mjs";
import { recordIssue, recordApprovalRequested, getItem } from "./inbox-store.mjs";
import { wireInbox, handleInboxRoute } from "./inbox-service.mjs";

const DB_PATH = path.join(os.tmpdir(), `inbox-svc-${randomUUID().slice(0, 8)}.db`);
initDb(DB_PATH);
test.after(() => { try { fs.unlinkSync(DB_PATH); } catch {} });

const broadcasts = [];
wireInbox({ broadcast: (type, props) => broadcasts.push({ type, props }), sessionLabel: () => "Test Agent" });

// Minimal req/res doubles that capture what the handler wrote.
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; return this; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
}
function call(method, pathAndQuery, { body, authOk = true } = {}) {
  const url = new URL(`http://x${pathAndQuery}`);
  const res = fakeRes();
  const req = { method };
  const deps = { authOk: () => authOk, readBody: async () => (body ? JSON.stringify(body) : "") };
  return handleInboxRoute(req, res, url, deps).then((handled) => ({ handled, res }));
}

test("returns false for a non-inbox path", async () => {
  const { handled } = await call("GET", "/session");
  assert.equal(handled, false);
});

test("GET /api/inbox returns persisted items", async () => {
  recordIssue({ id: `iss_${randomUUID().slice(0, 8)}`, title: "svc issue", createdAt: Date.now() });
  const { handled, res } = await call("GET", "/api/inbox?filter=attention");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.items.some((i) => i.title === "svc issue"));
});

test("POST /api/inbox/:id/resolve resolves an issue and broadcasts", async () => {
  const id = `iss_${randomUUID().slice(0, 8)}`;
  recordIssue({ id, title: "resolve me", createdAt: Date.now() });
  broadcasts.length = 0;
  const { res } = await call("POST", `/api/inbox/${id}/resolve`, { body: { note: "ok" } });
  assert.deepEqual(res.body, { ok: true });
  assert.equal(getItem(id).status, "resolved");
  assert.ok(broadcasts.some((b) => b.type === "inbox.updated" && b.props.id === id));
});

test("accept on an orphaned approval resolves the row (live:false)", async () => {
  const id = `appr_${randomUUID().slice(0, 8)}`;
  recordApprovalRequested({ id, tool: "t", args: { a: 1 }, createdAt: Date.now() });
  const { res } = await call("POST", `/api/approvals/${id}/accept`, { body: { arguments: { a: 2 } } });
  assert.deepEqual(res.body, { ok: true, live: false });
  const item = getItem(id);
  assert.equal(item.status, "accepted");
  assert.deepEqual(item.args, { a: 2 });
});

test("401 when unauthorized", async () => {
  const { res } = await call("GET", "/api/inbox", { authOk: false });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
});
