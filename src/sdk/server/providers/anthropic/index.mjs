// Anthropic provider: drives @anthropic-ai/claude-agent-sdk in-process and maps
// its messages to the canonical wire. Routes through LiteLLM via env (the SDK
// reads ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY — same lever as inline-adapter).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { toFrames } from "./transformation.mjs";

export const id = "anthropic";
export const aliases = ["claude-agent", "claude", "claude-code", "cc"];
export const harnessId = "claude-code";
export const displayName = "Claude Code";

// LiteLLM is optional. When both LITELLM_API_BASE and LITELLM_API_KEY are set,
// route the SDK (and the claude CLI it drives) through the gateway; otherwise
// leave the SDK's own ANTHROPIC_* env in place (direct to the provider). The
// Anthropic SDK appends "/v1/messages", so strip a trailing "/v1". A pre-set
// ANTHROPIC_BASE_URL always wins (don't clobber an explicit override).
function applyLiteLlmEnv(env) {
  if (!env.LITELLM_API_BASE || !env.LITELLM_API_KEY) return;
  if (!process.env.ANTHROPIC_BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = env.LITELLM_API_BASE.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || env.LITELLM_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || env.LITELLM_API_KEY;
}

export function createRuntime({ model, permissionMode, cwd, env = process.env, diagnostics = () => {} }) {
  applyLiteLlmEnv(env);
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
