// Decode tests: assert wire objects map to the right typed shapes and that
// unknown types fall back safely instead of throwing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeMessage } from "../dist/decode.js";

test("decodes an assistant message with mixed content blocks", () => {
  const msg = decodeMessage({
    type: "assistant",
    message: {
      model: "m",
      content: [
        { type: "text", text: "hi" },
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } },
        { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
      ],
    },
    parent_tool_use_id: null,
  });
  assert.equal(msg.type, "assistant");
  assert.equal(msg.message.content.length, 4);
  assert.equal(msg.message.content[0].type, "text");
  assert.equal(msg.message.content[1].type, "thinking");
  assert.equal(msg.message.content[2].type, "tool_use");
  assert.deepEqual(msg.message.content[2].input, { path: "/x" });
  assert.equal(msg.message.content[3].type, "tool_result");
  assert.equal(msg.message.content[3].is_error, false);
});

test("decodes a result message", () => {
  const msg = decodeMessage({
    type: "result",
    subtype: "success",
    duration_ms: 5,
    duration_api_ms: 3,
    is_error: false,
    num_turns: 2,
    session_id: "s",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1 },
    result: "done",
  });
  assert.equal(msg.type, "result");
  assert.equal(msg.subtype, "success");
  assert.equal(msg.total_cost_usd, 0.01);
  assert.equal(msg.result, "done");
});

test("unknown subtype on result falls back to error_during_execution", () => {
  const msg = decodeMessage({ type: "result", subtype: "weird" });
  assert.equal(msg.subtype, "error_during_execution");
});

test("system message preserves arbitrary extra fields", () => {
  const msg = decodeMessage({ type: "system", subtype: "init", session_id: "s", foo: 42 });
  assert.equal(msg.type, "system");
  assert.equal(msg.subtype, "init");
  assert.equal(msg.foo, 42);
});

test("unknown top-level type maps to a safe system fallback (no throw)", () => {
  const msg = decodeMessage({ type: "totally_unknown", payload: 1 });
  assert.equal(msg.type, "system");
  assert.equal(msg.subtype, "unknown");
  assert.equal(msg.payload, 1);
});

test("unknown content block type becomes a text block", () => {
  const msg = decodeMessage({
    type: "assistant",
    message: { model: "m", content: [{ type: "mystery", a: 1 }] },
    parent_tool_use_id: null,
  });
  assert.equal(msg.message.content[0].type, "text");
  assert.match(msg.message.content[0].text, /mystery/);
});

test("non-object input does not throw", () => {
  const msg = decodeMessage(null);
  assert.equal(msg.type, "system");
});

test("assistant/user messages carry optional session_id and uuid when present", () => {
  const assistant = decodeMessage({
    type: "assistant",
    message: { model: "m", content: [{ type: "text", text: "hi" }] },
    parent_tool_use_id: null,
    session_id: "sess-1",
    uuid: "uuid-1",
  });
  assert.equal(assistant.session_id, "sess-1");
  assert.equal(assistant.uuid, "uuid-1");

  const user = decodeMessage({
    type: "user",
    message: { content: "hello" },
    session_id: "sess-2",
    uuid: "uuid-2",
  });
  assert.equal(user.session_id, "sess-2");
  assert.equal(user.uuid, "uuid-2");

  // Absent fields stay undefined (decode is lenient, fields are optional).
  const bare = decodeMessage({
    type: "assistant",
    message: { model: "m", content: [] },
    parent_tool_use_id: null,
  });
  assert.equal(bare.session_id, undefined);
  assert.equal(bare.uuid, undefined);
});

test("stream_event message decodes", () => {
  const msg = decodeMessage({ type: "stream_event", event: { delta: "x" }, session_id: "s" });
  assert.equal(msg.type, "stream_event");
  assert.deepEqual(msg.event, { delta: "x" });
  assert.equal(msg.session_id, "s");
});
