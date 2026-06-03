// Anthropic provider: drives @anthropic-ai/claude-agent-sdk in-process and maps
// its messages to the canonical wire. Routes through LiteLLM via env (the SDK
// reads ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY — same lever as inline-adapter).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { toFrames } from "./transformation.mjs";

export const id = "anthropic";
export const aliases = ["claude-agent", "claude", "claude-code", "cc"];
export const harnessId = "claude-code";
export const displayName = "Claude Code";

// AI gateway routing is optional. Accepts either the LiteLLM-specific vars
// (LITELLM_API_BASE / LITELLM_API_KEY) or the generic vars
// (AI_GATEWAY_API_BASE / AI_GATEWAY_API_KEY); LITELLM_* takes precedence when
// both are set. The Anthropic SDK appends "/v1/messages", so strip a trailing
// "/v1". A pre-set ANTHROPIC_BASE_URL always wins (don't clobber an explicit
// override).
function applyGatewayEnv(env) {
  const base = env.LITELLM_API_BASE || env.AI_GATEWAY_API_BASE;
  const key = env.LITELLM_API_KEY || env.AI_GATEWAY_API_KEY;
  if (!base || !key) return;
  if (!process.env.ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = base.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || key;
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || key;
}

export function createRuntime({ model, permissionMode, cwd, env = process.env, diagnostics = () => {} }) {
  applyGatewayEnv(env);
  let currentModel = model || env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
  let mode = permissionMode || "default";
  let controller = null;

  return {
    get model() {
      return currentModel;
    },
    setModel(next) {
      if (next) currentModel = next;
    },
    setPermissionMode(next) {
      mode = next || "default";
    },
    interrupt() {
      controller?.abort();
    },
    async *runTurn({ prompt, session }) {
      controller = new AbortController();
      const stream = query({
        prompt,
        options: {
          model: currentModel,
          cwd,
          permissionMode: mode,
          includePartialMessages: true,
          abortController: controller,
        },
      });
      try {
        for await (const msg of stream) {
          for (const frame of toFrames(msg, { sessionId: session.sessionId })) yield frame;
        }
      } catch (err) {
        if (controller.signal.aborted) return; // session emits the cancelled result
        diagnostics(`anthropic runtime error: ${err?.message ?? err}\n`);
        throw err;
      } finally {
        controller = null;
      }
    },
  };
}
