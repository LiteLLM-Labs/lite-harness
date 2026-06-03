// Codex provider: drives the OpenAI Agents SDK (@openai/agents) in-process and
// maps its run-stream events to the canonical wire. Routes through LiteLLM by
// installing a custom OpenAI client (OpenAI-compatible /v1) as the default and
// using the chat-completions surface (what LiteLLM serves).
import { Agent, run, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from "@openai/agents";
import OpenAI from "openai";
import { eventToFrames } from "./transformation.mjs";

export const id = "codex";
export const aliases = ["openai-agents", "openai"];

// LiteLLM is optional. When both LITELLM_API_BASE and LITELLM_API_KEY are set,
// route through the gateway's OpenAI-compatible /v1 (chat-completions surface).
// Otherwise leave the Agents SDK's default client in place — direct to OpenAI
// via OPENAI_API_KEY.
let configured = false;
function configure(env) {
  if (configured) return;
  configured = true;
  setTracingDisabled(true);
  if (!env.LITELLM_API_BASE || !env.LITELLM_API_KEY) return;
  const base = env.LITELLM_API_BASE.replace(/\/+$/, "");
  const baseURL = base.endsWith("/v1") ? base : `${base}/v1`;
  setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey: env.LITELLM_API_KEY }));
  setOpenAIAPI("chat_completions");
}

export function createRuntime({ model, env = process.env, diagnostics = () => {} }) {
  configure(env);
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
      const agent = new Agent({
        name: "codex",
        model: currentModel,
        instructions: "You are a coding agent.",
      });
      const streamed = await run(agent, prompt, { stream: true, signal: aborter.signal });
      try {
        for await (const event of streamed) {
          for (const frame of eventToFrames(event, { sessionId: session.sessionId, model: currentModel })) {
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
