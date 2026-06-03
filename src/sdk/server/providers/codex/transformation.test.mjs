import { test } from "node:test";
import assert from "node:assert/strict";
import { eventToFrames } from "./transformation.mjs";

const opts = { sessionId: "sess_test", model: "gpt-x" };

test("text delta → content_block_delta stream_event frame", () => {
  const event = {
    type: "raw_model_stream_event",
    data: { type: "output_text_delta", delta: "4" },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "stream_event",
      session_id: "sess_test",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "4" },
      },
    },
  ]);
});

test("other raw model stream events are ignored", () => {
  for (const t of ["response_started", "model", "response_done"]) {
    const event = { type: "raw_model_stream_event", data: { type: t } };
    assert.deepEqual(eventToFrames(event, opts), [], `expected [] for data.type=${t}`);
  }
});

test("completed message_output_created → assistant frame with text block", () => {
  const event = {
    type: "run_item_stream_event",
    name: "message_output_created",
    item: {
      type: "message_output_item",
      rawItem: {
        id: "x",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "4" }],
      },
    },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "assistant",
      message: { model: "gpt-x", content: [{ type: "text", text: "4" }] },
      parent_tool_use_id: null,
    },
  ]);
});

test("run_item_stream_event with a different name is ignored", () => {
  const event = { type: "run_item_stream_event", name: "tool_called", item: {} };
  assert.deepEqual(eventToFrames(event, opts), []);
});

test("message_output_created with no output_text blocks is ignored", () => {
  const event = {
    type: "run_item_stream_event",
    name: "message_output_created",
    item: { rawItem: { content: [{ type: "tool_use", id: "t1" }] } },
  };
  assert.deepEqual(eventToFrames(event, opts), []);
});

test("agent_updated_stream_event and non-object input are ignored", () => {
  const event = { type: "agent_updated_stream_event", agent: { name: "x" } };
  assert.deepEqual(eventToFrames(event, opts), []);
  assert.deepEqual(eventToFrames(null, opts), []);
  assert.deepEqual(eventToFrames(undefined, opts), []);
  assert.deepEqual(eventToFrames("nope", opts), []);
});
