import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../../../../../src/sdk/server/providers/codex/index.mjs";

// Fake Codex client: records which thread calls were made and with what
// options, and emits a minimal turn whose thread.started carries `threadId`.
function fakeCodex(threadId = "thr_1") {
  const calls = [];
  const thread = (kind, id, options) => {
    calls.push({ kind, id, options });
    return {
      async runStreamed() {
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: threadId };
            yield { type: "item.completed", item: { id: "m", type: "agent_message", text: "ok" } };
            yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
          })(),
        };
      },
    };
  };
  return {
    calls,
    startThread: (options) => thread("start", null, options),
    resumeThread: (id, options) => thread("resume", id, options),
  };
}

const session = { sessionId: "sess_test", startedAt: 0 };

async function drain(runtime, prompt) {
  const frames = [];
  for await (const frame of runtime.runTurn({ prompt, session })) frames.push(frame);
  return frames;
}

test("first turn starts a thread, later turns resume it", async () => {
  const codex = fakeCodex();
  const runtime = createRuntime({ model: "gpt-x", cwd: "/w", env: {}, codex });
  await drain(runtime, "one");
  await drain(runtime, "two");
  await drain(runtime, "three");
  assert.deepEqual(
    codex.calls.map((c) => [c.kind, c.id]),
    [["start", null], ["resume", "thr_1"], ["resume", "thr_1"]],
  );
});

test("model and permission changes apply on resume without starting a new thread", async () => {
  const codex = fakeCodex();
  const runtime = createRuntime({ model: "gpt-x", cwd: "/w", env: {}, codex });
  await drain(runtime, "one");
  runtime.setModel("gpt-y");
  runtime.setPermissionMode("acceptEdits");
  await drain(runtime, "two");
  const second = codex.calls[1];
  assert.equal(second.kind, "resume");
  assert.equal(second.id, "thr_1");
  assert.equal(second.options.model, "gpt-y");
  assert.equal(second.options.sandboxMode, "workspace-write");
  assert.equal(second.options.workingDirectory, "/w");
});

test("separate runtimes do not share a thread", async () => {
  const a = fakeCodex("thr_a");
  const b = fakeCodex("thr_b");
  await drain(createRuntime({ env: {}, codex: a }), "hi");
  await drain(createRuntime({ env: {}, codex: b }), "hi");
  assert.equal(a.calls[0].kind, "start");
  assert.equal(b.calls[0].kind, "start");
});
