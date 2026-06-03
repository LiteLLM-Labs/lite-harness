import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./mock-server.mjs", import.meta.url));

function startServer(extraArgs = []) {
  const child = spawn(process.execPath, [
    serverPath,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...extraArgs,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  const lines = [];
  rl.on("line", (line) => lines.push(JSON.parse(line)));

  return {
    child,
    lines,
    write(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    async nextLine() {
      while (lines.length === 0) {
        await once(rl, "line");
      }
      return lines.shift();
    },
    async close() {
      child.stdin.end();
      await once(child, "exit");
      rl.close();
    },
  };
}

test("control requests resolve with matching request ids", async () => {
  const server = startServer();
  try {
    server.write({
      type: "control_request",
      request_id: "req_1",
      request: { subtype: "initialize", hooks: {}, sdk_mcp_servers: [] },
    });
    server.write({
      type: "control_request",
      request_id: "req_2",
      request: { subtype: "set_permission_mode", permission_mode: "acceptEdits" },
    });

    assert.deepEqual(await server.nextLine(), {
      type: "control_response",
      response: { request_id: "req_1", subtype: "success" },
    });
    assert.deepEqual(await server.nextLine(), {
      type: "control_response",
      response: { request_id: "req_2", subtype: "success" },
    });
  } finally {
    await server.close();
  }
});

test("unknown control subtype returns a correlated error response", async () => {
  const server = startServer();
  try {
    server.write({
      type: "control_request",
      request_id: "req_bad",
      request: { subtype: "nope" },
    });
    const line = await server.nextLine();
    assert.equal(line.type, "control_response");
    assert.equal(line.response.request_id, "req_bad");
    assert.equal(line.response.subtype, "error");
    assert.match(line.response.error, /unsupported control request subtype/);
  } finally {
    await server.close();
  }
});

test("user turns emit system, assistant, and result with stable session id", async () => {
  const server = startServer(["--agent", "codex", "--model", "mock-x"]);
  try {
    server.write({
      type: "user",
      message: { role: "user", content: "hello" },
      session_id: null,
      parent_tool_use_id: null,
    });

    const system = await server.nextLine();
    const assistant = await server.nextLine();
    const result = await server.nextLine();

    assert.equal(system.type, "system");
    assert.equal(system.subtype, "init");
    assert.equal(system.model, "mock-x");

    assert.equal(assistant.type, "assistant");
    assert.equal(
      assistant.message.content[0].text,
      "Mock reply from codex using mock-x: hello",
    );

    assert.equal(result.type, "result");
    assert.equal(result.subtype, "success");
    assert.equal(result.session_id, system.session_id);
    assert.equal(result.num_turns, 1);
    assert.equal(result.result, "Mock reply from codex using mock-x: hello");

    server.write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "again" }] },
      session_id: null,
      parent_tool_use_id: null,
    });
    const secondSystem = await server.nextLine();
    await server.nextLine();
    const secondResult = await server.nextLine();
    assert.equal(secondSystem.session_id, system.session_id);
    assert.equal(secondResult.num_turns, 2);
  } finally {
    await server.close();
  }
});

test("malformed JSON is reported on stderr without corrupting stdout", async () => {
  const server = startServer();
  const stderr = [];
  server.child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  try {
    server.child.stdin.write("{bad json\n");
    server.write({
      type: "control_request",
      request_id: "req_ok",
      request: { subtype: "initialize" },
    });

    const line = await server.nextLine();
    assert.equal(line.response.request_id, "req_ok");
    assert.match(stderr.join(""), /Ignoring malformed JSON line/);
  } finally {
    await server.close();
  }
});
