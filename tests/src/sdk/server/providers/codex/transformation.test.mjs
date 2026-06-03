import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventTransformer } from "../../../../../../src/sdk/server/providers/codex/transformation.mjs";

const opts = { sessionId: "sess_test", model: "gpt-x" };

function makeTransformer() {
  return createEventTransformer();
}

test("item.started with agent_message text → content_block_delta stream_event", () => {
  const toFrames = makeTransformer();
  const event = {
    type: "item.started",
    item: { id: "item_1", type: "agent_message", text: "Hello" },
  };
  assert.deepEqual(toFrames(event, opts), [
    {
      type: "stream_event",
      session_id: "sess_test",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    },
  ]);
});

test("item.started with empty text is ignored", () => {
  const toFrames = makeTransformer();
  const event = {
    type: "item.started",
    item: { id: "item_1", type: "agent_message", text: "" },
  };
  assert.deepEqual(toFrames(event, opts), []);
});

test("item.updated emits only new characters as delta", () => {
  const toFrames = makeTransformer();
  toFrames({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "Hel" } }, opts);
  const event = {
    type: "item.updated",
    item: { id: "item_1", type: "agent_message", text: "Hello" },
  };
  assert.deepEqual(toFrames(event, opts), [
    {
      type: "stream_event",
      session_id: "sess_test",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
    },
  ]);
});

test("item.updated with no new text is ignored", () => {
  const toFrames = makeTransformer();
  toFrames({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "Hello" } }, opts);
  const event = {
    type: "item.updated",
    item: { id: "item_1", type: "agent_message", text: "Hello" },
  };
  assert.deepEqual(toFrames(event, opts), []);
});

test("item.completed → assistant frame with full text", () => {
  const toFrames = makeTransformer();
  const event = {
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "The answer is 4" },
  };
  assert.deepEqual(toFrames(event, opts), [
    {
      type: "assistant",
      message: { model: "gpt-x", content: [{ type: "text", text: "The answer is 4" }] },
      parent_tool_use_id: null,
    },
  ]);
});

test("multiple items tracked independently", () => {
  const toFrames = makeTransformer();
  toFrames({ type: "item.started", item: { id: "a", type: "agent_message", text: "foo" } }, opts);
  toFrames({ type: "item.started", item: { id: "b", type: "agent_message", text: "bar" } }, opts);

  const deltaA = toFrames({ type: "item.updated", item: { id: "a", type: "agent_message", text: "fooX" } }, opts);
  assert.deepEqual(deltaA[0].event.delta.text, "X");

  const deltaB = toFrames({ type: "item.updated", item: { id: "b", type: "agent_message", text: "barY" } }, opts);
  assert.deepEqual(deltaB[0].event.delta.text, "Y");
});

test("non-agent_message item types are ignored", () => {
  const toFrames = makeTransformer();
  for (const type of ["command_execution", "file_change", "reasoning", "web_search", "todo_list", "error"]) {
    const event = { type: "item.updated", item: { id: "x", type, text: "ignored" } };
    assert.deepEqual(toFrames(event, opts), [], `expected [] for item.type=${type}`);
  }
});

test("turn.completed, thread.started, turn.started, error events are ignored", () => {
  const toFrames = makeTransformer();
  for (const type of ["turn.completed", "thread.started", "turn.started", "turn.failed", "error"]) {
    const event = { type };
    assert.deepEqual(toFrames(event, opts), [], `expected [] for event.type=${type}`);
  }
});

test("null, undefined, non-object inputs are ignored", () => {
  const toFrames = makeTransformer();
  assert.deepEqual(toFrames(null, opts), []);
  assert.deepEqual(toFrames(undefined, opts), []);
  assert.deepEqual(toFrames("nope", opts), []);
  assert.deepEqual(toFrames(42, opts), []);
});

test("each transformer instance has isolated state", () => {
  const a = makeTransformer();
  const b = makeTransformer();
  a({ type: "item.started", item: { id: "item_1", type: "agent_message", text: "hello" } }, opts);
  // b has not seen item_1, so full text is the delta
  const frames = b({ type: "item.updated", item: { id: "item_1", type: "agent_message", text: "hello" } }, opts);
  assert.deepEqual(frames[0].event.delta.text, "hello");
});
