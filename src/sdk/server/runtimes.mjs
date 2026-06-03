import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

function splitCommand(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

function commandFromEnv(env, names, fallback) {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return splitCommand(value);
  }
  return [fallback];
}

function assistantLine({ model, text }) {
  return {
    type: "assistant",
    message: {
      model,
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

function resultLine({ sessionId, turns, startedAt, text, error = null }) {
  const durationMs = Math.max(0, Date.now() - startedAt);
  return {
    type: "result",
    subtype: error ? "error_during_execution" : "success",
    session_id: sessionId,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    is_error: Boolean(error),
    num_turns: turns,
    total_cost_usd: 0,
    usage: {},
    result: error ? error.message : text,
  };
}

function systemLine({ sessionId, model, mcpServers }) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: [],
    mcp_servers: mcpServers,
  };
}

export class ClaudeCodeRuntime {
  constructor({ model, permissionMode, cwd, env, diagnostics }) {
    this.model = model || env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
    this.permissionMode = permissionMode || "default";
    this.cwd = cwd;
    this.env = env;
    this.diagnostics = diagnostics;
    this.activeChild = null;
  }

  setModel(model) {
    this.model = model || this.env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
  }

  setPermissionMode(permissionMode) {
    this.permissionMode = permissionMode || "default";
  }

  interrupt() {
    this.activeChild?.kill("SIGTERM");
  }

  async runTurn({ prompt, session }) {
    const [bin, ...baseArgs] = commandFromEnv(
      this.env,
      ["CLAUDE_CODE_COMMAND", "CLAUDE_COMMAND"],
      "claude",
    );
    const args = [
      ...baseArgs,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.model,
      "--permission-mode",
      this.permissionMode,
      "--cwd",
      this.cwd,
    ];

    const child = spawn(bin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeChild = child;
    child.stderr.on("data", (chunk) => this.diagnostics(chunk.toString("utf8")));

    const output = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === "object" && msg.type !== "control_response") {
          output.push(msg);
        }
      } catch {
        this.diagnostics(`Ignoring malformed Claude Code output: ${line}\n`);
      }
    });

    child.stdin.write(`${JSON.stringify({
      type: "control_request",
      request_id: "req_server_initialize",
      request: { subtype: "initialize", hooks: {}, sdk_mcp_servers: session.sdkMcpServers },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
      session_id: null,
      parent_tool_use_id: null,
    })}\n`);
    child.stdin.end();

    const [code] = await once(child, "exit");
    this.activeChild = null;
    rl.close();
    if (code !== 0 && code !== null) {
      throw new Error(`claude-code exited with code ${code}`);
    }

    if (output.some((msg) => msg.type === "result")) return output;

    const text = output
      .filter((msg) => msg.type === "assistant")
      .flatMap((msg) => msg.message?.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return [
      ...output,
      resultLine({ sessionId: session.sessionId, turns: session.turns, startedAt: session.startedAt, text }),
    ];
  }
}

export class CodexRuntime {
  constructor({ model, cwd, env, diagnostics }) {
    this.model = model || env.CODEX_MODEL || "gpt-4o";
    this.cwd = cwd;
    this.env = env;
    this.diagnostics = diagnostics;
    this.activeChild = null;
  }

  setModel(model) {
    this.model = model || this.env.CODEX_MODEL || "gpt-4o";
  }

  interrupt() {
    this.activeChild?.kill("SIGTERM");
  }

  async runTurn({ prompt, session }) {
    const [bin, ...baseArgs] = commandFromEnv(this.env, ["CODEX_COMMAND"], "codex");
    const fullPrompt = session.history.length > 0
      ? `${session.history.map((msg) => `${msg.role}: ${msg.text}`).join("\n\n")}\n\nUser: ${prompt}`
      : prompt;
    const args = [...baseArgs, "exec"];
    const litellmBase = this.env.LITELLM_API_BASE;
    if (litellmBase) {
      args.push(
        "-c",
        "model_providers.litellm.name=LiteLLM",
        "-c",
        `model_providers.litellm.base_url=${litellmBase.replace(/\/+$/, "")}`,
        "-c",
        "model_providers.litellm.env_key=LITELLM_API_KEY",
        "-c",
        "model_provider=litellm",
      );
    }
    args.push("-m", this.model, "--dangerously-bypass-approvals-and-sandbox", fullPrompt);

    const child = spawn(bin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeChild = child;

    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => this.diagnostics(chunk.toString("utf8")));

    const [code] = await once(child, "exit");
    this.activeChild = null;
    if (code !== 0 && code !== null) {
      throw new Error(`codex exited with code ${code}`);
    }

    return [
      assistantLine({ model: this.model, text }),
      resultLine({ sessionId: session.sessionId, turns: session.turns, startedAt: session.startedAt, text }),
    ];
  }
}

export function createRuntime({ agent, model, permissionMode, cwd, env = process.env, diagnostics }) {
  const normalized = (agent || "claude").toLowerCase();
  if (normalized === "codex") {
    return new CodexRuntime({ model, cwd, env, diagnostics });
  }
  if (normalized === "claude" || normalized === "claude-code" || normalized === "cc") {
    return new ClaudeCodeRuntime({ model, permissionMode, cwd, env, diagnostics });
  }
  throw new Error(`unsupported agent runtime: ${agent}`);
}

export { assistantLine, resultLine, systemLine };
