import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  StreamJsonServer,
  controlResponse,
  resultFrame,
  systemInit,
} from "./protocol.mjs";

// ---------------------------------------------------------------------------
// Test harness. Drives StreamJsonServer over in-memory streams: a PassThrough
// for stdin, and writables that collect parsed NDJSON (stdout) / raw text
// (stderr). No network, no spawning, no real providers.
// ---------------------------------------------------------------------------
function makeHarness(session) {
  const stdin = new PassThrough();

  const stdoutLines = [];
  const stdout = new PassThrough();
  stdout.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) stdoutLines.push(JSON.parse(line));
    }
  });

  const stderrChunks = [];
  const stderr = new PassThrough();
  stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));

  const server = new StreamJsonServer({ session, stdin, stdout, stderr }).start();

  function feed(...objsOrLines) {
    for (const item of objsOrLines) {
      const line = typeof item === "string" ? item : JSON.stringify(item);
      stdin.write(`${line}\n`);
    }
  }

  // Wait until at least `n` stdout lines have been collected (deterministic),
  // bounded by a timeout so a never-arriving line fails fast instead of hanging.
  async function waitForLines(n, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (stdoutLines.length < n) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${n} stdout line(s); got ${stdoutLines.length}`,
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return stdoutLines;
  }

  // Settle: give the event loop a few ticks so any (unexpected) stdout writes land.
  async function tick(ms = 20) {
    await new Promise((r) => setTimeout(r, ms));
  }

  return {
    server,
    stdoutLines,
    feed,
    waitForLines,
    tick,
    stderr: () => stderrChunks.join(""),
  };
}

function makeMockSession() {
  const controlCalls = [];
  return {
    sessionId: "sess_mock",
    turns: 0,
    controlCalls,
    async handleControl(request) {
      controlCalls.push(request);
      if (request.subtype === "boom") {
        throw new Error("kaboom");
      }
      return { ok: true };
    },
    async *runTurn({ prompt }) {
      yield { type: "system", subtype: "init", session_id: "sess_mock", model: "m" };
      yield {
        type: "assistant",
        message: { model: "m", content: [{ type: "text", text: "echo:" + prompt }] },
        parent_tool_use_id: null,
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: "sess_mock",
        is_error: false,
        result: "echo:" + prompt,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Wire-layer tests (injected mock session)
// ---------------------------------------------------------------------------
test("control_request initialize -> single success control_response", async () => {
  const session = makeMockSession();
  const h = makeHarness(session);

  h.feed({
    type: "control_request",
    request_id: "req_init",
    request: { subtype: "initialize", hooks: {}, sdk_mcp_servers: [] },
  });

  const lines = await h.waitForLines(1);
  await h.tick(); // ensure no extra lines slip in

  assert.equal(lines.length, 1, "exactly one stdout line");
  const [line] = lines;
  assert.equal(line.type, "control_response");
  assert.equal(line.response.request_id, "req_init");
  assert.equal(line.response.subtype, "success");

  assert.equal(session.controlCalls.length, 1);
  assert.equal(session.controlCalls[0].subtype, "initialize");
});

test("control_request whose handleControl throws -> correlated error response", async () => {
  const session = makeMockSession();
  const h = makeHarness(session);

  h.feed({
    type: "control_request",
    request_id: "req_boom",
    request: { subtype: "boom" },
  });

  const lines = await h.waitForLines(1);
  await h.tick();

  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.type, "control_response");
  assert.equal(line.response.request_id, "req_boom");
  assert.equal(line.response.subtype, "error");
  assert.equal(typeof line.response.error, "string");
  assert.match(line.response.error, /kaboom/);
});

test("user message -> system, assistant, result frames streamed in order", async () => {
  const session = makeMockSession();
  const h = makeHarness(session);

  h.feed({
    type: "user",
    message: { role: "user", content: "hi there" },
    session_id: null,
    parent_tool_use_id: null,
  });

  const lines = await h.waitForLines(3);
  await h.tick();

  assert.equal(lines.length, 3, "exactly three frames streamed (not dropped)");

  const [system, assistant, result] = lines;

  assert.equal(system.type, "system");
  assert.equal(system.subtype, "init");
  assert.equal(system.session_id, "sess_mock");
  assert.equal(system.model, "m");

  assert.equal(assistant.type, "assistant");
  assert.equal(assistant.message.model, "m");
  assert.equal(assistant.message.content[0].type, "text");
  assert.equal(assistant.message.content[0].text, "echo:hi there");
  assert.equal(assistant.parent_tool_use_id, null);

  assert.equal(result.type, "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.session_id, "sess_mock");
  assert.equal(result.is_error, false);
  assert.equal(result.result, "echo:hi there");
});

test("malformed JSON line -> no stdout, stderr notes it, then valid request works", async () => {
  const session = makeMockSession();
  const h = makeHarness(session);

  h.feed("{bad");
  await h.tick();

  assert.equal(h.stdoutLines.length, 0, "malformed line produces no stdout frame");
  assert.match(h.stderr(), /Ignoring malformed JSON line/);

  // A valid control_request still works afterwards.
  h.feed({
    type: "control_request",
    request_id: "req_after",
    request: { subtype: "initialize" },
  });

  const lines = await h.waitForLines(1);
  await h.tick();

  assert.equal(lines.length, 1);
  assert.equal(lines[0].response.request_id, "req_after");
  assert.equal(lines[0].response.subtype, "success");
});

// ---------------------------------------------------------------------------
// Frame builder unit tests
// ---------------------------------------------------------------------------
test("controlResponse('r1') -> success shape", () => {
  assert.deepEqual(controlResponse("r1"), {
    type: "control_response",
    response: { request_id: "r1", subtype: "success" },
  });
});

test("controlResponse('r1', {error}) -> error shape", () => {
  assert.deepEqual(controlResponse("r1", { error: "x" }), {
    type: "control_response",
    response: { request_id: "r1", subtype: "error", error: "x" },
  });
});

test("resultFrame has all PROTOCOL.md-required fields", () => {
  const frame = resultFrame({
    sessionId: "s",
    turns: 1,
    startedAt: Date.now(),
    text: "hi",
  });

  for (const field of [
    "type",
    "subtype",
    "session_id",
    "duration_ms",
    "duration_api_ms",
    "is_error",
    "num_turns",
    "total_cost_usd",
    "usage",
    "result",
  ]) {
    assert.ok(field in frame, `result frame missing field: ${field}`);
  }

  assert.equal(frame.type, "result");
  assert.equal(frame.subtype, "success");
  assert.equal(frame.session_id, "s");
  assert.equal(frame.is_error, false);
  assert.equal(frame.num_turns, 1);
  assert.equal(frame.result, "hi");
  assert.equal(typeof frame.duration_ms, "number");
  assert.equal(typeof frame.duration_api_ms, "number");
  assert.equal(typeof frame.total_cost_usd, "number");
  assert.deepEqual(frame.usage, {});
});

test("systemInit shape", () => {
  assert.deepEqual(systemInit({ sessionId: "s", model: "m" }), {
    type: "system",
    subtype: "init",
    session_id: "s",
    model: "m",
    tools: [],
    mcp_servers: [],
  });
});
