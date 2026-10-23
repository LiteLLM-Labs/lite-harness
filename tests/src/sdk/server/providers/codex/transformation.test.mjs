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

test("non-tool, non-agent_message item updates are ignored", () => {
  const toFrames = makeTransformer();
  for (const type of ["file_change", "reasoning", "web_search", "todo_list", "error"]) {
    const event = { type: "item.updated", item: { id: "x", type, text: "ignored" } };
    assert.deepEqual(toFrames(event, opts), [], `expected [] for item.type=${type}`);
  }
});

test("thread.started and turn.started events are ignored", () => {
  const toFrames = makeTransformer();
  for (const type of ["thread.started", "turn.started"]) {
    assert.deepEqual(toFrames({ type }, opts), [], `expected [] for event.type=${type}`);
  }
});

test("command_execution → tool_use on start, tool_result on completion", () => {
  const toFrames = makeTransformer();
  const started = toFrames(
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
    opts,
  );
  assert.deepEqual(started, [
    {
      type: "assistant",
      message: { model: "gpt-x", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } }] },
      parent_tool_use_id: null,
    },
  ]);
  assert.deepEqual(
    toFrames({ type: "item.updated", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "..", status: "in_progress" } }, opts),
    [],
  );
  const completed = toFrames(
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "1 failing", exit_code: 1, status: "completed" } },
    opts,
  );
  assert.deepEqual(completed, [
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "1 failing", is_error: true }] } },
  ]);
});

test("file_change completion → ApplyPatch tool_use + tool_result", () => {
  const toFrames = makeTransformer();
  const frames = toFrames(
    { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" } },
    opts,
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].message.content[0].name, "ApplyPatch");
  assert.deepEqual(frames[1].message.content[0], { type: "tool_result", tool_use_id: "f1", content: "update a.ts", is_error: false });
});

test("reasoning completion → thinking block", () => {
  const toFrames = makeTransformer();
  const frames = toFrames({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "hmm" } }, opts);
  assert.deepEqual(frames[0].message.content, [{ type: "thinking", thinking: "hmm" }]);
});

test("turn.completed → result frame with mapped usage and last message text", () => {
  const toFrames = makeTransformer();
  toFrames({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } }, opts);
  const [frame] = toFrames(
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } },
    opts,
  );
  assert.equal(frame.type, "result");
  assert.equal(frame.is_error, false);
  assert.equal(frame.result, "done");
  assert.deepEqual(frame.usage, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 });
});

test("turn.failed → error result frame", () => {
  const toFrames = makeTransformer();
  const [failed] = toFrames({ type: "turn.failed", error: { message: "boom" } }, opts);
  assert.equal(failed.is_error, true);
  assert.equal(failed.result, "boom");
});

test("error events are transient: no frame, but remembered for turn.failed", () => {
  const toFrames = makeTransformer();
  assert.deepEqual(toFrames({ type: "error", message: "Reconnecting... 2/5" }, opts), []);
  const [failed] = toFrames({ type: "turn.failed" }, opts);
  assert.equal(failed.result, "Reconnecting... 2/5");
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
