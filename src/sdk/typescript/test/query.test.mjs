// End-to-end test: drives query() against the deterministic fake server over
// the stream-json control protocol (PROTOCOL.md). Runs against the compiled
// output in ../dist (built by `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { listHarnesses, query } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "fake-server.mjs");

test("query() runs the full lifecycle and yields messages ending in result", async () => {
  const q = query({
    prompt: "hello world",
    options: {
      env: { ...process.env, LITE_HARNESS_SERVER: `node ${fakeServer}` },
    },
  });

  const messages = [];
  for await (const msg of q) {
    messages.push(msg);
  }

  const types = messages.map((m) => m.type);
  assert.deepEqual(types, ["system", "assistant", "result"]);

  const system = messages[0];
  assert.equal(system.subtype, "init");

  const assistant = messages[1];
  assert.equal(assistant.message.model, "claude-fake");
  assert.equal(assistant.message.content[0].type, "text");
  assert.equal(assistant.message.content[0].text, "echo: hello world");
  assert.equal(assistant.parent_tool_use_id, null);

  const result = messages[2];
  assert.equal(result.subtype, "success");
  assert.equal(result.is_error, false);
  assert.equal(result.result, "echo: hello world");
  assert.equal(result.num_turns, 1);
});

test("early break tears down without hanging", async () => {
  const q = query({
    prompt: "hi",
    options: {
      env: { ...process.env, LITE_HARNESS_SERVER: `node ${fakeServer}` },
    },
  });

  let count = 0;
  for await (const _msg of q) {
    count += 1;
    break; // triggers return() -> teardown
  }
  assert.equal(count, 1);
  // close() after break must be safe / idempotent.
  q.close();
});

test("control methods resolve against a live session", async () => {
  const q = query({
    prompt: "control",
    options: {
      env: { ...process.env, LITE_HARNESS_SERVER: `node ${fakeServer}` },
    },
  });

  // First pull starts the session.
  const first = await q.next();
  assert.equal(first.done, false);

  await q.setPermissionMode("acceptEdits");
  await q.setModel("claude-x");
  await q.setModel();
  await q.interrupt();

  // Drain to completion.
  // eslint-disable-next-line no-empty
  for await (const _m of q) {
  }
});

test("harness option is accepted as the primary runtime selector", async () => {
  const q = query({
    prompt: "harness",
    options: {
      harness: "openai",
      model: "gpt-5.5",
      env: { ...process.env, LITE_HARNESS_SERVER: `node ${fakeServer}` },
    },
  });

  const messages = [];
  for await (const msg of q) {
    messages.push(msg);
  }

  assert.equal(messages.at(-1).result, "echo: harness");
});

test("listHarnesses() returns available harness metadata", async () => {
  const harnesses = await listHarnesses({
    options: {
      env: { ...process.env, LITE_HARNESS_SERVER: `node ${fakeServer}` },
    },
  });

  assert.deepEqual(
    harnesses.map((harness) => harness.id),
    ["claude-code", "codex"],
  );
  assert.equal(harnesses[0].name, "Claude Code");
  assert.deepEqual(harnesses[0].aliases, ["claude", "cc"]);
  assert.deepEqual(harnesses[1].aliases, ["openai"]);
});
