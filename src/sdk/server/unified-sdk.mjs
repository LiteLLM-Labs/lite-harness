import { randomUUID } from "node:crypto";
import { createRuntime, resultLine, systemLine } from "./runtimes.mjs";

function sessionId() {
  return `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function assistantText(lines) {
  return lines
    .filter((line) => line.type === "assistant")
    .flatMap((line) => line.message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export class UnifiedAgentSDK {
  constructor({ agent, model, permissionMode, cwd, env = process.env, stderr = process.stderr }) {
    this.agent = agent;
    this.defaultModel = model;
    this.model = model;
    this.permissionMode = permissionMode;
    this.cwd = cwd;
    this.env = env;
    this.stderr = stderr;
    this.sessionId = sessionId();
    this.turns = 0;
    this.sdkMcpServers = [];
    this.hooks = {};
    this.history = [];
    this.startedAt = Date.now();
    this.runtime = createRuntime({
      agent,
      model,
      permissionMode,
      cwd,
      env,
      diagnostics: (line) => this.stderr.write(line),
    });
  }

  async handleControl(request) {
    const subtype = request.subtype;
    switch (subtype) {
      case "initialize":
        this.hooks = request.hooks && typeof request.hooks === "object" ? request.hooks : {};
        this.sdkMcpServers = Array.isArray(request.sdk_mcp_servers) ? request.sdk_mcp_servers : [];
        return;
      case "interrupt":
        this.runtime.interrupt?.();
        return;
      case "set_permission_mode":
        this.permissionMode =
          typeof request.permission_mode === "string" ? request.permission_mode : "default";
        this.runtime.setPermissionMode?.(this.permissionMode);
        return;
      case "set_model":
        this.model = typeof request.model === "string" && request.model.length > 0
          ? request.model
          : this.defaultModel;
        this.runtime.setModel?.(this.model);
        return;
      default:
        throw new Error(`unsupported control request subtype: ${String(subtype)}`);
    }
  }

  async runTurn({ prompt, content }) {
    this.turns += 1;
    this.startedAt = Date.now();
    this.history.push({ role: "User", text: prompt, content });

    const context = {
      sessionId: this.sessionId,
      turns: this.turns,
      startedAt: this.startedAt,
      sdkMcpServers: this.sdkMcpServers,
      history: this.history.slice(0, -1),
    };
    const runtimeLines = await this.runtime.runTurn({ prompt, content, session: context });
    const hasSystem = runtimeLines.some((line) => line.type === "system");
    const lines = hasSystem
      ? runtimeLines
      : [
          systemLine({
            sessionId: this.sessionId,
            model: this.model || this.runtime.model,
            mcpServers: this.sdkMcpServers,
          }),
          ...runtimeLines,
        ];

    const text = assistantText(lines);
    if (text) this.history.push({ role: "Assistant", text });
    return lines;
  }

  errorResult(err) {
    return resultLine({
      sessionId: this.sessionId,
      turns: this.turns,
      startedAt: this.startedAt,
      text: "",
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
