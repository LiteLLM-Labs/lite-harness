import { test } from "node:test";
import assert from "node:assert/strict";
import { eventToFrames } from "../../../../../../src/sdk/server/providers/pi-ai/transformation.mjs";

const opts = { sessionId: "sess_test", model: "gpt-4o" };

// --- message_update ---

test("message_update with string delta → stream_event text_delta", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", content: "Hi" },
    assistantMessageEvent: { type: "text_delta", delta: "Hi" },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "stream_event",
      session_id: "sess_test",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    },
  ]);
});

test("message_update with no assistantMessageEvent → []", () => {
  const event = { type: "message_update", message: { role: "assistant", content: "" } };
  assert.deepEqual(eventToFrames(event, opts), []);
});

test("message_update with non-string delta → []", () => {
  const event = {
    type: "message_update",
    message: { role: "assistant", content: "" },
    assistantMessageEvent: { type: "thinking_delta", delta: null },
  };
  assert.deepEqual(eventToFrames(event, opts), []);
});

// --- message_end ---

test("message_end with assistant + content array → assistant frame", () => {
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "4" }, { type: "thinking", text: "..." }],
    },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "assistant",
      message: { model: "gpt-4o", content: [{ type: "text", text: "4" }] },
      parent_tool_use_id: null,
    },
  ]);
});

test("message_end with assistant + content string → assistant frame", () => {
  const event = {
    type: "message_end",
    message: { role: "assistant", content: "Hello!" },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "assistant",
      message: { model: "gpt-4o", content: [{ type: "text", text: "Hello!" }] },
      parent_tool_use_id: null,
    },
  ]);
});

test("message_end with non-assistant role → []", () => {
  const event = {
    type: "message_end",
    message: { role: "user", content: "ok" },
  };
  assert.deepEqual(eventToFrames(event, opts), []);
});

test("message_end with empty content → []", () => {
  const event = {
    type: "message_end",
    message: { role: "assistant", content: [] },
  };
  assert.deepEqual(eventToFrames(event, opts), []);
});

// --- tool_execution_start ---

test("tool_execution_start → assistant frame with tool_use block", () => {
  const event = {
    type: "tool_execution_start",
    toolCallId: "call_abc",
    toolName: "read_file",
    args: { path: "/foo.ts" },
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "assistant",
      message: {
        model: "gpt-4o",
        content: [{ type: "tool_use", id: "call_abc", name: "read_file", input: { path: "/foo.ts" } }],
      },
      parent_tool_use_id: null,
    },
  ]);
});

// --- tool_execution_end ---

test("tool_execution_end success → user frame with tool_result", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "call_abc",
    toolName: "read_file",
    result: "file contents here",
    isError: false,
  };
  assert.deepEqual(eventToFrames(event, opts), [
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_abc",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    },
  ]);
});

test("tool_execution_end error → user frame with is_error: true", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "call_xyz",
    toolName: "bash",
    result: "command not found",
    isError: true,
  };
  const frames = eventToFrames(event, opts);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "user");
  assert.equal(frames[0].message.content[0].is_error, true);
});

test("tool_execution_end with object result → JSON-serialized string", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "list",
    result: { files: ["a.ts", "b.ts"] },
    isError: false,
  };
  const frames = eventToFrames(event, opts);
  assert.equal(frames[0].message.content[0].content, JSON.stringify({ files: ["a.ts", "b.ts"] }));
});

// --- ignored events ---

test("agent_start, agent_end, turn_start, turn_end → []", () => {
  for (const type of ["agent_start", "agent_end", "turn_start", "turn_end"]) {
    assert.deepEqual(eventToFrames({ type }, opts), [], `expected [] for ${type}`);
  }
});

test("message_start, tool_execution_update → []", () => {
  assert.deepEqual(eventToFrames({ type: "message_start", message: {} }, opts), []);
  assert.deepEqual(
    eventToFrames({ type: "tool_execution_update", toolCallId: "x", partialResult: "..." }, opts),
    []
  );
});

test("unknown event type → []", () => {
  assert.deepEqual(eventToFrames({ type: "future_event_type", data: {} }, opts), []);
});

test("null, undefined, non-object → []", () => {
  assert.deepEqual(eventToFrames(null, opts), []);
  assert.deepEqual(eventToFrames(undefined, opts), []);
  assert.deepEqual(eventToFrames("nope", opts), []);
  assert.deepEqual(eventToFrames(42, opts), []);
});
