# lite-harness SDK

The SDK to swap between agent harnesses: Claude Agent SDK, OpenAI Agents, and
Pi AI.

Keep one application interface and choose the harness per call:

```txt
your app -> lite-harness SDK -> claude-agent | openai-agents | pi-ai
```

Use provider-native auth for the simplest path. Add LiteLLM AI Gateway only when
you want central model routing, keys, budgets, logs, or fallbacks.

## Available harnesses

- `claude-agent`: Claude Agent SDK / Claude Code behavior.
  Upstream: [Python](https://github.com/anthropics/claude-agent-sdk-python),
  [TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript).
- `openai-agents`: OpenAI Agents SDK behavior.
  Upstream: [Python](https://github.com/openai/openai-agents-python),
  [TypeScript](https://github.com/openai/openai-agents-js).
- `pi-ai`: Pi's local coding-agent harness.
  Upstream: [GitHub](https://github.com/earendil-works/pi),
  [SDK docs](https://pi.dev/docs/latest/sdk).

`harness` selects the agent runtime. `model` selects the model that runtime uses.

## Python

### Python: quickstart

Install the SDK and set provider keys for the harnesses you want to use:

```bash
pip install lite-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-openai-...
```

```python
from lite_agent_sdk import query, AgentOptions

# Claude Agent SDK harness
async for message in query(
    prompt="Hello from Claude",
    options=AgentOptions(
        harness="claude-agent",
        model="claude-opus-4-8",
    ),
):
    print(message)

# OpenAI Agents harness
async for message in query(
    prompt="Hello from OpenAI Agents",
    options=AgentOptions(
        harness="openai-agents",
        model="gpt-5.5",
    ),
):
    print(message)

# Pi AI harness
async for message in query(
    prompt="Hello from Pi AI",
    options=AgentOptions(
        harness="pi-ai",
        model="claude-opus-4-8",
    ),
):
    print(message)
```

### Python: migrate from Claude Agent SDK

If you already use Claude Agent SDK, the migration is one import change plus a
`harness` selector.

```diff
- from claude_agent_sdk import query, ClaudeAgentOptions
+ from lite_agent_sdk import query, AgentOptions

  async for message in query(
      prompt="Hello from Claude",
-     options=ClaudeAgentOptions(
-         model="claude-opus-4-8",
-     ),
+     options=AgentOptions(
+         harness="claude-agent",
+         model="claude-opus-4-8",
+     ),
  ):
      print(message)
```

### Python: use LiteLLM AI Gateway

LiteLLM AI Gateway is optional. Use it when you want all harnesses to use one
OpenAI-compatible model gateway.

```bash
export LITELLM_API_BASE=https://litellm.your-company.com/v1
export LITELLM_API_KEY=sk-litellm-...
```

```python
from lite_agent_sdk import query, AgentOptions

async for message in query(
    prompt="Refactor the billing service and explain the diff.",
    options=AgentOptions(
        harness="openai-agents",
        model="anthropic/claude-opus-4-8",
    ),
):
    print(message)
```

## JavaScript / TypeScript

### JavaScript: quickstart

Install the SDK and set provider keys for the harnesses you want to use:

```bash
npm install @lite-harness/sdk
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-openai-...
```

```ts
import { query } from "@lite-harness/sdk";

// Claude Agent SDK harness
for await (const message of query({
  prompt: "Hello from Claude",
  options: {
    harness: "claude-agent",
    model: "claude-opus-4-8"
  }
})) {
  console.log(message);
}

// OpenAI Agents harness
for await (const message of query({
  prompt: "Hello from OpenAI Agents",
  options: {
    harness: "openai-agents",
    model: "gpt-5.5"
  }
})) {
  console.log(message);
}

// Pi AI harness
for await (const message of query({
  prompt: "Hello from Pi AI",
  options: {
    harness: "pi-ai",
    model: "claude-opus-4-8"
  }
})) {
  console.log(message);
}
```

### JavaScript: migrate from Claude Agent SDK

If you already use Claude Agent SDK, the migration is one import change plus a
`harness` selector.

```diff
- import { query } from "@anthropic-ai/claude-agent-sdk";
+ import { query } from "@lite-harness/sdk";

  for await (const message of query({
    prompt: "Hello from Claude",
    options: {
-     model: "claude-opus-4-8"
+     harness: "claude-agent",
+     model: "claude-opus-4-8"
    }
  })) {
    console.log(message);
  }
```

### JavaScript: use LiteLLM AI Gateway

LiteLLM AI Gateway is optional. Use it when you want all harnesses to use one
OpenAI-compatible model gateway.

```bash
export LITELLM_API_BASE=https://litellm.your-company.com/v1
export LITELLM_API_KEY=sk-litellm-...
```

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Refactor the billing service and explain the diff.",
  options: {
    harness: "openai-agents",
    model: "anthropic/claude-opus-4-8"
  }
})) {
  console.log(message);
}
```

## Mental model

- `harness`: which agent SDK/runtime handles the task.
  Examples: `claude-agent`, `openai-agents`, `pi-ai`.
- `model`: which model that harness uses.
  Examples: `claude-opus-4-8`, `gpt-5.5`.

## Status

This directory currently contains the SDK contract and interface reference. The
Python and TypeScript packages, plus parity tests against the supported harness
surfaces, follow in subsequent changes.
