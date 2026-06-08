// Hermes provider: drives the @openai/codex-sdk in-process against any
// OpenAI-compatible local endpoint (Ollama, vLLM, LiteLLM) and maps its
// ThreadEvents to the canonical wire using the same transformation as codex.
import { Codex } from "@openai/codex-sdk";
import { createEventTransformer } from "../codex/transformation.mjs";

export const id = "hermes";
export const aliases = ["nous-hermes", "hermes-agent"];

function buildCodexOptions(env) {
  const base = env.HERMES_API_BASE;
  if (!base) throw new Error("HERMES_API_BASE is required for the hermes provider");
  const baseUrl = base.replace(/\/+$/, "");
  return { baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`, apiKey: env.HERMES_API_KEY || "ollama" };
}

export function createRuntime({ model, env = process.env, diagnostics = () => {} }) {
  let currentModel = model || env.HERMES_DEFAULT_MODEL;
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
        diagnostics(`hermes runtime error: ${err?.message ?? err}\n`);
        throw err;
      } finally {
        aborter = null;
      }
    },
  };
}
