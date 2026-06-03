// Pi AI provider: drives @earendil-works/pi-agent-core in-process and maps
// its AgentEvents to the canonical wire. Routes through LiteLLM via env when
// LITELLM_API_BASE + LITELLM_API_KEY are set (OpenAI-compatible completions
// endpoint); otherwise falls through to OPENAI_API_KEY direct.
import { agentLoop } from "@earendil-works/pi-agent-core";
import { eventToFrames } from "./transformation.mjs";

export const id = "pi-ai";
export const aliases = ["pi"];

function buildModel(modelId, env) {
  const raw = env.LITELLM_API_BASE || "https://api.openai.com";
  const stripped = raw.replace(/\/+$/, "");
  const baseUrl = stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function convertToLlm(messages) {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  );
}

export function createRuntime({ model, env = process.env, diagnostics = () => {} }) {
  let currentModel = model || env.LITELLM_DEFAULT_MODEL || "gpt-4o";
  let aborter = null;

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
      const signal = aborter.signal;

      const userMsg = {
        role: "user",
        content: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
        timestamp: Date.now(),
      };

      const context = {
        systemPrompt: "You are a helpful coding assistant.",
        messages: [],
        tools: [],
      };

      const modelObj = buildModel(currentModel, env);
      const config = {
        model: modelObj,
        convertToLlm,
        getApiKey: async () => env.LITELLM_API_KEY || env.OPENAI_API_KEY,
      };

      const stream = agentLoop([userMsg], context, config, signal);

      try {
        for await (const event of stream) {
          for (const frame of eventToFrames(event, { sessionId: session.sessionId, model: currentModel })) {
            yield frame;
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        diagnostics(`pi-ai runtime error: ${err?.message ?? err}\n`);
        throw err;
      } finally {
        aborter = null;
      }
    },
  };
}
