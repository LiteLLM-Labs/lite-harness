import { createInterface } from "node:readline";

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
    .map((block) => {
      if (block && typeof block === "object" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

export class StreamJsonServer {
  constructor({ sdk, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr }) {
    this.sdk = sdk;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.activeTurn = null;
  }

  start() {
    const rl = createInterface({ input: this.stdin });
    rl.on("line", (line) => this.handleLine(line));
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
      await this.sdk.handleControl(request);
      this.write({ type: "control_response", response: { request_id: requestId, subtype: "success" } });
    } catch (err) {
      this.write({
        type: "control_response",
        response: {
          request_id: requestId,
          subtype: "error",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  startTurn(msg) {
    if (this.activeTurn) {
      this.write({
        type: "result",
        subtype: "error_during_execution",
        session_id: this.sdk.sessionId,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: this.sdk.turns,
        total_cost_usd: 0,
        usage: {},
        result: "A turn is already in progress",
      });
      return;
    }

    const content = msg.message && typeof msg.message === "object" ? msg.message.content : "";
    this.activeTurn = this.runTurn(content)
      .catch((err) => {
        this.write(this.sdk.errorResult(err));
      })
      .finally(() => {
        this.activeTurn = null;
      });
  }

  async runTurn(content) {
    const lines = await this.sdk.runTurn({ prompt: contentToText(content), content });
    for (const line of lines) {
      this.write(line);
    }
  }
}

