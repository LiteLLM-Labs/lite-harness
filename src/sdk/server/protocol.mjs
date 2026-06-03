import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Launch flags. The SDK spawns us mirroring the claude CLI:
//   --input-format stream-json --output-format stream-json --verbose
//   [--agent <a>] [--model <m>] [--permission-mode <p>] [--cwd <dir>]
// Unknown flags are tolerated and ignored (forward-compatible with the CLI).
// ---------------------------------------------------------------------------
export function parseLaunchArgs(argv, defaults = {}) {
  const options = {
    agent: defaults.agent ?? "claude",
    model: defaults.model ?? null,
    permissionMode: defaults.permissionMode ?? "default",
    cwd: defaults.cwd ?? process.cwd(),
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    i += 1;

    switch (arg) {
      case "--input-format":
        if (value !== "stream-json") throw new Error(`unsupported input format: ${value}`);
        break;
      case "--output-format":
        if (value !== "stream-json") throw new Error(`unsupported output format: ${value}`);
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

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Canonical frame builders — the one place the PROTOCOL.md wire shapes live.
// ---------------------------------------------------------------------------
export function controlResponse(requestId, { error, ...fields } = {}) {
  return error === undefined
    ? { type: "control_response", response: { request_id: requestId, subtype: "success", ...fields } }
    : {
        type: "control_response",
        response: { request_id: requestId, subtype: "error", error: String(error) },
      };
}

export function systemInit({ sessionId, model, mcpServers = [], tools = [] }) {
  return { type: "system", subtype: "init", session_id: sessionId, model, tools, mcp_servers: mcpServers };
}

export function assistantFrame({ model, content, parentToolUseId = null }) {
  return { type: "assistant", message: { model, content }, parent_tool_use_id: parentToolUseId };
}

export function streamEventFrame({ sessionId, event }) {
  return { type: "stream_event", session_id: sessionId, event };
}

export function resultFrame({
  sessionId,
  turns = 1,
  startedAt,
  text = "",
  subtype,
  isError = false,
  usage = {},
  totalCostUsd = 0,
}) {
  const duration = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
  return {
    type: "result",
    subtype: subtype ?? (isError ? "error_during_execution" : "success"),
    session_id: sessionId,
    duration_ms: duration,
    duration_api_ms: duration,
    is_error: isError,
    num_turns: turns,
    total_cost_usd: totalCostUsd,
    usage,
    result: text,
  };
}

// ---------------------------------------------------------------------------
// The wire. Reads NDJSON from stdin, demuxes on `type`, correlates control
// requests, and streams a turn's frames to stdout AS THEY ARRIVE.
// ---------------------------------------------------------------------------
export class StreamJsonServer {
  constructor({ session, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
    this.session = session;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.activeTurn = null;
  }

  start() {
    const rl = createInterface({ input: this.stdin });
    rl.on("line", (line) => this.handleLine(line));
    return this;
  }

  write(obj) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  async handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.stderr.write("Ignoring malformed JSON line\n");
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "control_request") {
      await this.handleControlRequest(msg);
      return;
    }
    if (msg.type === "user") {
      this.startTurn(msg);
    }
  }

  async handleControlRequest(msg) {
    const requestId = msg.request_id;
    const request = msg.request && typeof msg.request === "object" ? msg.request : {};
    try {
      const result = await this.session.handleControl(request);
      this.write(controlResponse(requestId, result && typeof result === "object" ? result : undefined));
    } catch (err) {
      this.write(controlResponse(requestId, { error: err instanceof Error ? err.message : err }));
    }
  }

  startTurn(msg) {
    if (this.activeTurn) {
      this.write(
        resultFrame({
          sessionId: this.session.sessionId,
          turns: this.session.turns,
          text: "A turn is already in progress",
          isError: true,
        }),
      );
      return;
    }

    const content = msg.message && typeof msg.message === "object" ? msg.message.content : "";
    this.activeTurn = this.runTurn(content)
      .catch((err) => {
        this.write(
          resultFrame({
            sessionId: this.session.sessionId,
            turns: this.session.turns,
            text: err instanceof Error ? err.message : String(err),
            isError: true,
          }),
        );
      })
      .finally(() => {
        this.activeTurn = null;
      });
  }

  async runTurn(content) {
    for await (const frame of this.session.runTurn({ prompt: contentToText(content), content })) {
      this.write(frame);
    }
  }
}
