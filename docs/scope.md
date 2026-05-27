# Scope

## What lite-harness is

lite-harness is a single HTTP server that runs in front of coding-agent harnesses (opencode, claude-code, claude-agent-sdk, openai-agents) and gives you **one API** to drive any of them.

A harness is the runtime around a coding agent: the loop that takes a user message, calls the LLM, executes tools, persists state, and emits events. Every harness in the wild speaks its own dialect. Different session formats, different event shapes, different model-routing conventions. lite-harness collapses that into three endpoints:

- `POST /session`. Create a session, pick the harness in one field.
- `POST /session/{id}/prompt_async`. Send a prompt with a LiteLLM-routed model.
- `GET /event`. SSE stream of every session event.

Everything else (the chat UI, the inspector panel, durable session storage, the load-balanced web worker in front of an HPA-managed pool of harness pods) is built on top of those three endpoints.

## Who it's for

- **Platform teams** standing up an internal coding-agent product. You want one URL your team hits, not four different agent SDKs to integrate.
- **Eval and benchmark authors** comparing harnesses on the same task. Swap `harness: opencode` for `harness: claude-code` and rerun.
- **Anyone running coding agents at scale.** lite-harness is designed for 10K RPS. Durable sessions, HPA-friendly, cron jobs co-located with the web worker.

## What's in scope

- A unified HTTP API across every supported harness.
- Durable session storage (resume mid-conversation after a restart).
- Server-sent event stream for live UI and debugging.
- A Next.js chat UI and inspector panel, served from the same process.
- Model routing via a LiteLLM gateway. Every harness uses your gateway, your keys, your budgets.
- Horizontal scale: one web worker, many harness pods behind it.

## What's out of scope

- **A sandbox.** lite-harness runs the harness; it does not provide the isolation layer. For sandboxing and credential vaulting, use [LiteLLM Agent Platform (LAP)](https://github.com/BerriAI/litellm-agent-platform), which can use lite-harness as its harness layer.
- **A credential vault.** Same reason. LAP handles that.
- **Authoring new harnesses.** lite-harness adapts existing harnesses; it doesn't try to be one.
- **An LLM gateway.** That's [LiteLLM](https://github.com/BerriAI/litellm). lite-harness depends on it.

## Design rules

1. **Three endpoints, no more.** Every feature must fit into `/session`, `/session/{id}/prompt_async`, or `/event`. If it doesn't fit, it's the wrong feature.
2. **Same shape across harnesses.** A client written against opencode must work against claude-code with one field changed. No harness-specific request fields leak through.
3. **One server, one process.** Web, cron, and UI all live in the same Docker image. No worker-vs-web split.
4. **Durable by default.** A session survives a pod restart. Always.
5. **LiteLLM is the only path to a model.** No direct provider SDK calls from inside a harness adapter.

## Architecture at a glance

```
   your team  ->  lite-harness web worker  ->  [ opencode pod | opencode pod | claude-code pod | ... ]
                  |- /session, /prompt_async, /event       (HPA-scaled, durable sessions)
                  |- cron jobs
                  |- chat UI + inspector
                          |
                          v
                  LiteLLM gateway  ->  Claude / GPT / Gemini / Bedrock / ...
```

## Relationship to other BerriAI projects

| Project                                                  | Role                                                    |
|----------------------------------------------------------|---------------------------------------------------------|
| [LiteLLM](https://github.com/BerriAI/litellm)            | LLM gateway. lite-harness routes every call through it. |
| lite-harness (this repo)                                 | Unified API in front of coding-agent harnesses.         |
| [LAP](https://github.com/BerriAI/litellm-agent-platform) | Sandboxes and vault around lite-harness sessions.       |
