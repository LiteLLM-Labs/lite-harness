/**
 * Tests for issues.mjs — the agent-filed issue helper.
 *
 * Run: node --test mcp/issues.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileIssue, setIssueSink, _reset } from "./issues.mjs";

test("fileIssue forwards a normalized issue to the sink and returns its id", () => {
  _reset();
  const seen = [];
  setIssueSink((i) => seen.push(i));
  const id = fileIssue({ title: "Deploy blocked", body: "failing test", session: "ses_9" });
  assert.match(id, /^iss_/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, id);
  assert.equal(seen[0].title, "Deploy blocked");
  assert.equal(seen[0].body, "failing test");
  assert.equal(seen[0].session, "ses_9");
  assert.ok(seen[0].createdAt > 0);
  _reset();
});

test("fileIssue defaults a blank title and works without a sink", () => {
  _reset();
  const id = fileIssue({ body: "no title" });
  assert.match(id, /^iss_/);
  _reset();
  const seen = [];
  setIssueSink((i) => seen.push(i));
  fileIssue({ title: "   " });
  assert.equal(seen[0].title, "Untitled issue");
  assert.equal(seen[0].session, null);
  _reset();
});

test("a throwing sink does not blow up fileIssue", () => {
  _reset();
  setIssueSink(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => fileIssue({ title: "x" }));
  _reset();
});
