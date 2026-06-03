import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

async function writeCommandRecorder(name, source) {
  const dir = await mkdtemp(join(tmpdir(), "lite-harness-sdk-server-"));
  const scriptPath = join(dir, `${name}.mjs`);
  await writeFile(scriptPath, source, { mode: 0o755 });
  return scriptPath;
}

function startServer(extraArgs = [], { env = {} } = {}) {
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
    env: { ...process.env, ...env },
  });
  const rl = createInterface({ input: child.stdout });
  const lines = [];
  rl.on("line", (line) => lines.push(JSON.parse(line)));

  return {
    child,
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
  const commandPath = await writeCommandRecorder("claude-recorder", "process.exit(0);\n");
  const server = startServer(["--agent", "claude"], {
    env: { CLAUDE_CODE_COMMAND: `${process.execPath} ${commandPath}` },
  });
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
  const commandPath = await writeCommandRecorder("claude-recorder", "process.exit(0);\n");
  const server = startServer(["--agent", "claude"], {
    env: { CLAUDE_CODE_COMMAND: `${process.execPath} ${commandPath}` },
  });
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

test("claude runtime proxies stream-json command output", async () => {
  const commandPath = await writeCommandRecorder("claude-recorder", `
import { createInterface } from "node:readline";
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    write({ type: "control_response", response: { request_id: msg.request_id, subtype: "success" } });
    return;
  }
  if (msg.type !== "user") return;
  const prompt = msg.message?.content ?? "";
  write({ type: "system", subtype: "init", session_id: "sess_recorder_claude", model: "claude-recorder" });
  write({
    type: "assistant",
    message: { model: "claude-recorder", content: [{ type: "text", text: "claude says: " + prompt }] },
    parent_tool_use_id: null,
  });
  write({
    type: "result",
    subtype: "success",
    session_id: "sess_recorder_claude",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    result: "claude says: " + prompt,
  });
});
`);
  const server = startServer(["--agent", "claude", "--model", "claude-recorder"], {
    env: { CLAUDE_CODE_COMMAND: `${process.execPath} ${commandPath}` },
  });
  try {
    server.write({
      type: "user",
      message: { role: "user", content: "hello claude" },
      session_id: null,
      parent_tool_use_id: null,
    });

    const system = await server.nextLine();
    const assistant = await server.nextLine();
    const result = await server.nextLine();
    assert.equal(system.type, "system");
    assert.equal(assistant.message.content[0].text, "claude says: hello claude");
    assert.equal(result.result, "claude says: hello claude");
  } finally {
    await server.close();
  }
});

test("codex runtime normalizes codex exec stdout", async () => {
  const commandPath = await writeCommandRecorder("codex-recorder", `
const prompt = process.argv.at(-1) || "";
process.stdout.write("codex says: " + prompt);
`);
  const server = startServer(["--agent", "codex", "--model", "codex-recorder"], {
    env: { CODEX_COMMAND: `${process.execPath} ${commandPath}` },
  });
  try {
    server.write({
      type: "user",
      message: { role: "user", content: "hello codex" },
      session_id: null,
      parent_tool_use_id: null,
    });

    const system = await server.nextLine();
    const assistant = await server.nextLine();
    const result = await server.nextLine();
    assert.equal(system.type, "system");
    assert.equal(system.model, "codex-recorder");
    assert.equal(assistant.message.content[0].text, "codex says: hello codex");
    assert.equal(result.result, "codex says: hello codex");
  } finally {
    await server.close();
  }
});

test("malformed JSON is reported on stderr without corrupting stdout", async () => {
  const commandPath = await writeCommandRecorder("claude-recorder", "process.exit(0);\n");
  const server = startServer(["--agent", "claude"], {
    env: { CLAUDE_CODE_COMMAND: `${process.execPath} ${commandPath}` },
  });
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
