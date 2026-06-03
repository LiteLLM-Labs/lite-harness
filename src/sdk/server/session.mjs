import { randomUUID } from "node:crypto";
import { systemInit, resultFrame } from "./protocol.mjs";
import { listProviderMetadata } from "./providers/index.mjs";

// ---------------------------------------------------------------------------
// Session owns all process-local turn state. The wire (protocol.mjs) calls
// handleControl(request) for control_request messages and iterates runTurn()
// for user turns. The runtime (from a provider) does the actual model work and
// yields canonical frames; Session wraps those with system/init and result.
// ---------------------------------------------------------------------------

function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

export class Session {
  constructor({ provider, model, permissionMode, cwd, env, stderr }) {
    this.sessionId = `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.turns = 0;
    this.history = [];
    this.mcpServers = [];
    this.hooks = {};
    this.model = model;
    this.permissionMode = permissionMode;
    this.runtime = provider.createRuntime({
      model,
      permissionMode,
      cwd,
      env,
      diagnostics: (s) => stderr.write(s),
    });
  }

  async handleControl(request) {
    switch (request.subtype) {
      case "initialize":
        this.hooks = request.hooks || {};
        this.mcpServers = request.sdk_mcp_servers || [];
        return;
      case "interrupt":
        this.runtime.interrupt?.();
        return;
      case "set_permission_mode":
        this.permissionMode = request.permission_mode || "default";
        this.runtime.setPermissionMode?.(this.permissionMode);
        return;
      case "set_model":
        this.model = request.model || this.model;
        this.runtime.setModel?.(this.model);
        return;
      case "list_harnesses":
        return { harnesses: await listProviderMetadata() };
      default:
        throw new Error(`unsupported control request subtype: ${request.subtype}`);
    }
  }

  async *runTurn({ prompt, content }) {
    this.turns += 1;
    const startedAt = Date.now();
    this.history.push({ role: "user", text: prompt });

    yield systemInit({
      sessionId: this.sessionId,
      model: this.runtime.model,
      mcpServers: this.mcpServers,
    });

    let sawResult = false;
    let text = "";

    try {
      for await (const frame of this.runtime.runTurn({
        prompt,
        content,
        session: {
          sessionId: this.sessionId,
          turns: this.turns,
          startedAt,
          history: this.history.slice(0, -1),
          mcpServers: this.mcpServers,
        },
      })) {
        if (frame.type === "result") sawResult = true;
        if (frame.type === "assistant") text += assistantText(frame.message?.content);
        yield frame;
      }
    } catch (err) {
      yield resultFrame({
        sessionId: this.sessionId,
        turns: this.turns,
        startedAt,
        text: err?.message ?? String(err),
        isError: true,
      });
      return;
    }

    if (text) this.history.push({ role: "assistant", text });
    if (!sawResult) {
      yield resultFrame({ sessionId: this.sessionId, turns: this.turns, startedAt, text });
    }
  }
}
