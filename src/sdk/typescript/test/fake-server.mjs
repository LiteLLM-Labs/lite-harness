#!/usr/bin/env node
// Deterministic fake lite-harness server implementing PROTOCOL.md over NDJSON
// stdio (the Claude Agent SDK stream-json control protocol). Used by the test
// suite via the `command` transport override / `LITE_HARNESS_SERVER` resolution.
//
// Spawn flags (--input-format stream-json etc.) are ignored.
//
// On a `control_request` it replies with a `control_response` success echoing
// the request_id. On a `user` line it emits, in order:
//   1. a `system` init line,
//   2. one `assistant` line with a `text` block echoing the prompt content,
//   3. a terminating `result` line (subtype "success").
// It exits when stdin closes.

import { createInterface } from "node:readline";

let sessionCounter = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function controlResponse(requestId, fields = {}) {
  send({ type: "control_response", response: { request_id: requestId, subtype: "success", ...fields } });
}

function emitTurn(prompt) {
  const sessionId = `sess-${++sessionCounter}`;
  send({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fake" });
  send({
    type: "assistant",
    message: {
      model: "claude-fake",
      content: [{ type: "text", text: `echo: ${prompt}` }],
    },
    parent_tool_use_id: null,
  });
  send({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    result: `echo: ${prompt}`,
  });
}

function promptText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "list_harnesses") {
      controlResponse(msg.request_id, {
        harnesses: [
          {
            id: "claude-code",
            providerId: "anthropic",
            name: "Claude Code",
            aliases: ["claude", "cc"],
          },
          {
            id: "codex",
            providerId: "codex",
            name: "Codex",
            aliases: ["openai"],
          },
        ],
      });
      return;
    }
    // Every control subtype (initialize/interrupt/set_permission_mode/set_model)
    // is acknowledged the same way: success echoing the request_id.
    controlResponse(msg.request_id);
    return;
  }
  if (msg.type === "user") {
    const content = msg.message ? msg.message.content : undefined;
    setImmediate(() => emitTurn(promptText(content)));
    return;
  }
});

rl.on("close", () => process.exit(0));
