# Vision

**One server. Pick any harness, pick any model. Durable sessions, UI, and debugging out of the box.**

Lite-harness fronts every agent harness — opencode, Claude Agent SDK, OpenAI
Agents SDK — behind one API. Pick the harness, pick the model, get a session.
The transport, the loop, and the surface around it are the same.

## What you get

- **Any harness.** opencode, Claude Agent SDK, OpenAI Agents SDK. Swap by
  config, not by rewrite.
- **Any model.** Routed through LiteLLM — every provider, your keys, your
  rate limits, your fallbacks.
- **Durable sessions.** Survive restarts, deploys, and disconnects. Resume
  where you left off.
- **A chat UI.** Talk to any session from the browser. Inspect tool calls,
  diffs, and outputs inline.
- **Debugging + observability.** Every turn, tool call, token, and cost is
  captured and queryable. Trace a bad answer back to the prompt that caused it.

## Why this exists

Today, picking a harness locks you into its model story, its session story,
and its UI story. Switching harnesses means rebuilding the platform around it.
Lite-harness inverts that: the harness is a plugin, not the platform.

## Non-goals

- We don't write a new agent loop. We run the ones that already exist.
- We don't build prompts or tools for you. We host the runtime they live in.
- We don't replace your IDE or your CI. We sit next to them.
