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

### Python: quickstart with Claude Agent SDK

Start with the native Anthropic SDK:

```bash
pip install claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
```

```python
from claude_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="What is 2 + 2?",
    options=ClaudeAgentOptions(
        cwd=".",
        model="claude-sonnet-4-5",
    ),
):
    print(message)
```

### Python: migrate to lite-harness SDK

Install the lite-harness SDK and change the import:

```bash
pip install lite-agent-sdk
```

```python
# before
from claude_agent_sdk import query, ClaudeAgentOptions

# after
from lite_agent_sdk import query, ClaudeAgentOptions
```

The same call now runs through the selected harness:

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="What is 2 + 2?",
    options=ClaudeAgentOptions(
        harness="claude-agent",
        cwd=".",
        model="claude-sonnet-4-5",
    ),
):
    print(message)
```

### Python: switch to OpenAI Agents

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Inspect this repo and suggest the next test to write.",
    options=ClaudeAgentOptions(
        harness="openai-agents",
        cwd=".",
        model="gpt-4.1",
    ),
):
    print(message)
```

### Python: switch to Pi AI

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Review this SDK README and make it sharper.",
    options=ClaudeAgentOptions(
        harness="pi-ai",
        cwd=".",
        model="claude-sonnet-4-5",
    ),
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
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Refactor the billing service and explain the diff.",
    options=ClaudeAgentOptions(
        harness="openai-agents",
        cwd=".",
        model="anthropic/claude-sonnet-4-5",
        base_url="https://litellm.your-company.com/v1",
        api_key="sk-litellm-...",
    ),
):
    print(message)
```

## JavaScript / TypeScript

### JavaScript: quickstart with Claude Agent SDK

Start with the native Anthropic SDK:

```bash
npm install @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
```

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "What is 2 + 2?",
  options: {
    cwd: ".",
    model: "claude-sonnet-4-5"
  }
})) {
  console.log(message);
}
```

### JavaScript: migrate to lite-harness SDK

Install the lite-harness SDK and change the import:

```bash
npm install @lite-harness/sdk
```

```ts
// before
import { query } from "@anthropic-ai/claude-agent-sdk";

// after
import { query } from "@lite-harness/sdk";
```

The same call now runs through the selected harness:

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "What is 2 + 2?",
  options: {
    harness: "claude-agent",
    cwd: ".",
    model: "claude-sonnet-4-5"
  }
})) {
  console.log(message);
}
```

### JavaScript: switch to OpenAI Agents

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Inspect this repo and suggest the next test to write.",
  options: {
    harness: "openai-agents",
    cwd: ".",
    model: "gpt-4.1"
  }
})) {
  console.log(message);
}
```

### JavaScript: switch to Pi AI

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Review this SDK README and make it sharper.",
  options: {
    harness: "pi-ai",
    cwd: ".",
    model: "claude-sonnet-4-5"
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
    cwd: ".",
    model: "anthropic/claude-sonnet-4-5",
    baseUrl: "https://litellm.your-company.com/v1",
    apiKey: "sk-litellm-..."
  }
})) {
  console.log(message);
}
```

## Mental model

- `harness`: which agent SDK/runtime handles the task.
  Examples: `claude-agent`, `openai-agents`, `pi-ai`.
- `model`: which model that harness uses.
  Examples: `claude-sonnet-4-5`, `gpt-4.1`.
- `base_url` / `baseUrl`: optional OpenAI-compatible API base.
  Example: a LiteLLM AI Gateway URL.
- `api_key` / `apiKey`: optional key for the selected API base.
  Example: a LiteLLM virtual key.
- `cwd`: working directory for repo-aware agents.
  Example: `"."`.

## Status

This directory currently contains the SDK contract and interface reference. The
Python and TypeScript packages, plus parity tests against the supported harness
surfaces, follow in subsequent changes.
