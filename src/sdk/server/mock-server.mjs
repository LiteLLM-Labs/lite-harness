#!/usr/bin/env node
import { createInterface } from "node:readline";

const DEFAULT_AGENT = "mock-agent";
const DEFAULT_MODEL = "mock-model";

function parseArgs(argv) {
  const options = {
    agent: DEFAULT_AGENT,
    model: DEFAULT_MODEL,
    permissionMode: "default",
    cwd: process.cwd(),
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      continue;
    }
    i += 1;
    switch (arg) {
      case "--input-format":
        if (value !== "stream-json") {
          throw new Error(`unsupported input format: ${value}`);
        }
        break;
      case "--output-format":
        if (value !== "stream-json") {
          throw new Error(`unsupported output format: ${value}`);
        }
        break;
      case "--agent":
        options.agent = value;
        break;
      case "--model":
        options.model = value;
        break;
      case "--permission-mode":
        options.permissionMode = value;
        break;
      case "--cwd":
        options.cwd = value;
        break;
      default:
        break;
    }
  }

  return options;
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block && typeof block === "object" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

class MockServer {
  constructor(options) {
    this.agent = options.agent;
    this.defaultModel = options.model;
    this.model = options.model;
    this.permissionMode = options.permissionMode;
    this.cwd = options.cwd;
    this.sessionId = `sess_mock_${process.pid}`;
    this.turns = 0;
    this.activeTurn = null;
    this.hooks = {};
    this.sdkMcpServers = [];
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write("Ignoring malformed JSON line\n");
      return;
    }
    if (!msg || typeof msg !== "object") {
      return;
    }

    if (msg.type === "control_request") {
      this.handleControlRequest(msg);
      return;
    }
    if (msg.type === "user") {
      this.handleUserMessage(msg);
    }
  }

  handleControlRequest(msg) {
    const requestId = msg.request_id;
    const request = msg.request && typeof msg.request === "object" ? msg.request : {};
    const subtype = request.subtype;

    switch (subtype) {
      case "initialize":
        this.hooks = request.hooks && typeof request.hooks === "object" ? request.hooks : {};
        this.sdkMcpServers = Array.isArray(request.sdk_mcp_servers) ? request.sdk_mcp_servers : [];
        this.controlSuccess(requestId);
        return;
      case "interrupt":
        this.interruptActiveTurn();
        this.controlSuccess(requestId);
        return;
      case "set_permission_mode":
        this.permissionMode =
          typeof request.permission_mode === "string" ? request.permission_mode : "default";
        this.controlSuccess(requestId);
        return;
      case "set_model":
        this.model = typeof request.model === "string" && request.model.length > 0
          ? request.model
          : this.defaultModel;
        this.controlSuccess(requestId);
        return;
      default:
        this.controlError(requestId, `unsupported control request subtype: ${String(subtype)}`);
    }
  }

  controlSuccess(requestId) {
    write({ type: "control_response", response: { request_id: requestId, subtype: "success" } });
  }

  controlError(requestId, error) {
    write({ type: "control_response", response: { request_id: requestId, subtype: "error", error } });
  }

  handleUserMessage(msg) {
    const content = msg.message && typeof msg.message === "object" ? msg.message.content : "";
    const prompt = contentToText(content);
    const turn = {
      prompt,
      startedAt: Date.now(),
      timer: null,
      interrupted: false,
    };
    this.turns += 1;
    this.activeTurn = turn;

    write({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      model: this.model,
      tools: [],
      mcp_servers: this.sdkMcpServers,
    });

    turn.timer = setTimeout(() => this.finishTurn(turn), 5);
  }

  interruptActiveTurn() {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    turn.interrupted = true;
    if (turn.timer) {
      clearTimeout(turn.timer);
    }
    this.finishTurn(turn);
  }

  finishTurn(turn) {
    if (this.activeTurn !== turn) {
      return;
    }

    const durationMs = Math.max(0, Date.now() - turn.startedAt);
    if (turn.interrupted) {
      write({
        type: "result",
        subtype: "error_during_execution",
        session_id: this.sessionId,
        duration_ms: durationMs,
        duration_api_ms: durationMs,
        is_error: true,
        num_turns: this.turns,
        total_cost_usd: 0,
        usage: {},
        result: "Interrupted",
      });
      this.activeTurn = null;
      return;
    }

    const reply = `Mock reply from ${this.agent} using ${this.model}: ${turn.prompt}`;
    write({
      type: "assistant",
      message: {
        model: this.model,
        content: [{ type: "text", text: reply }],
      },
      parent_tool_use_id: null,
    });
    write({
      type: "result",
      subtype: "success",
      session_id: this.sessionId,
      duration_ms: durationMs,
      duration_api_ms: durationMs,
      is_error: false,
      num_turns: this.turns,
      total_cost_usd: 0,
      usage: {},
      result: reply,
    });
    this.activeTurn = null;
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const server = new MockServer(options);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => server.handleLine(line));
