import test from "node:test";
import assert from "node:assert/strict";

import { toFrames } from "./transformation.mjs";

const opts = { sessionId: "sess_test" };

test("system init is dropped (session emits its own init)", () => {
  const msg = { type: "system", subtype: "init", session_id: "x", model: "m" };
  assert.deepEqual(toFrames(msg, opts), []);
});

test("assistant is forwarded with content blocks unchanged", () => {
  const msg = {
    type: "assistant",
    message: { model: "claude-x", content: [{ type: "text", text: "4" }] },
    parent_tool_use_id: null,
  };
  assert.deepEqual(toFrames(msg, opts), [
    {
      type: "assistant",
      message: { model: "claude-x", content: [{ type: "text", text: "4" }] },
      parent_tool_use_id: null,
    },
  ]);
});

test("stream_event forwards event and rewrites session_id to our session", () => {
  const event = {
    type: "content_block_delta",
    delta: { type: "text_delta", text: "4" },
  };
  const msg = { type: "stream_event", session_id: "orig", event };
  const frames = toFrames(msg, opts);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    type: "stream_event",
    session_id: "sess_test",
    event,
  });
  // Explicitly assert the original session_id was NOT preserved.
  assert.equal(frames[0].session_id, "sess_test");
  assert.notEqual(frames[0].session_id, "orig");
});

test("result success forwards canonical fields and rewrites session_id", () => {
  const msg = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 4,
    num_turns: 1,
    result: "4",
    session_id: "orig",
    total_cost_usd: 0.001,
    usage: { input_tokens: 3 },
  };
  const frames = toFrames(msg, opts);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    type: "result",
    subtype: "success",
    session_id: "sess_test",
    duration_ms: 5,
    duration_api_ms: 4,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: { input_tokens: 3 },
    result: "4",
  });
});

test("result with is_error and no subtype maps to error_during_execution", () => {
  const msg = {
    type: "result",
    is_error: true,
    session_id: "orig",
  };
  const frames = toFrames(msg, opts);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].subtype, "error_during_execution");
  assert.equal(frames[0].is_error, true);
  assert.equal(frames[0].session_id, "sess_test");
});

test("user is forwarded with message unchanged", () => {
  const msg = { type: "user", message: { role: "user", content: "hi" } };
  assert.deepEqual(toFrames(msg, opts), [
    { type: "user", message: { role: "user", content: "hi" } },
  ]);
});

test("unknown type and non-object input return [] (forward-compatible)", () => {
  assert.deepEqual(toFrames({ type: "whatever" }, opts), []);
  assert.deepEqual(toFrames(null, opts), []);
  assert.deepEqual(toFrames(undefined, opts), []);
  assert.deepEqual(toFrames("not-an-object", opts), []);
});
