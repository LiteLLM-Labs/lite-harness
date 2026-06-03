// Codex provider: drives the @openai/codex-sdk in-process and maps its
// ThreadEvents to the canonical wire. Routes through LiteLLM by configuring
// baseUrl (passed as --config openai_base_url to the Codex CLI) and injecting
// LITELLM_API_KEY as OPENAI_API_KEY so the CLI's model calls hit the gateway.
import { Codex } from "@openai/codex-sdk";
import { createEventTransformer } from "./transformation.mjs";

export const id = "codex";
export const aliases = ["openai-agents", "openai"];
export const harnessId = "codex";
export const displayName = "Codex";

// AI gateway routing is optional. Accepts either the LiteLLM-specific vars
// (LITELLM_API_BASE / LITELLM_API_KEY) or the generic vars
// (AI_GATEWAY_API_BASE / AI_GATEWAY_API_KEY); LITELLM_* takes precedence when
// both are set. Otherwise the CLI's own OPENAI_API_KEY env var is used directly.
function buildCodexOptions(env) {
  const base = env.LITELLM_API_BASE || env.AI_GATEWAY_API_BASE;
  const key = env.LITELLM_API_KEY || env.AI_GATEWAY_API_KEY;
  if (!base || !key) return {};
  const stripped = base.replace(/\/+$/, "");
  const baseUrl = stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
  // Codex CLI inherits process.env; inject the gateway key as OPENAI_API_KEY so
  // model calls authenticate against the gateway.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || key;
  return { baseUrl };
}

export function createRuntime({ model, env = process.env, diagnostics = () => {} }) {
  let currentModel = model || env.LITELLM_DEFAULT_MODEL || "gpt-4o";
  let aborter = null;

  const codex = new Codex(buildCodexOptions(env));

  return {
    get model() {
      return currentModel;
    },
    setModel(next) {
      if (next) currentModel = next;
    },
    setPermissionMode() {},
    interrupt() {
      aborter?.abort();
    },
    async *runTurn({ prompt, session }) {
      aborter = new AbortController();
      const thread = codex.startThread({ model: currentModel, skipGitRepoCheck: true });
      const { events } = await thread.runStreamed(prompt, { signal: aborter.signal });
      const toFrames = createEventTransformer();
      try {
        for await (const event of events) {
          for (const frame of toFrames(event, { sessionId: session.sessionId, model: currentModel })) {
            yield frame;
          }
        }
      } catch (err) {
        if (aborter.signal.aborted) return; // session emits the cancelled result
        diagnostics(`codex runtime error: ${err?.message ?? err}\n`);
        throw err;
      } finally {
        aborter = null;
      }
    },
  };
}
