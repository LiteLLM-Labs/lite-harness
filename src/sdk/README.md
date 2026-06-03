# lite-harness SDK

Call every agent harness using one SDK: Claude Agent SDK, OpenAI Agents, and
Pi AI.

lite-harness SDK manages:

- One JavaScript and Python interface for multiple agent harnesses
- Harness switching with `harness`, model switching with `model`
- Claude Agent SDK-compatible streaming messages and errors
- Optional LiteLLM AI Gateway routing for keys, budgets, logs, and fallbacks

No gateway is required. Use provider-native API keys by default.

## JavaScript Usage

```bash
npm install @lite-harness/sdk
```

```ts
import { query } from "@lite-harness/sdk";

const prompt = "Fix the failing test";

// Claude Agent SDK harness
for await (const message of query({
  prompt,
  options: { harness: "claude-agent", model: "claude-opus-4-8" },
})) {
  console.log(message);
}

// OpenAI Agents harness
for await (const message of query({
  prompt,
  options: { harness: "openai-agents", model: "gpt-5.5" },
})) {
  console.log(message);
}

// Pi AI harness
for await (const message of query({
  prompt,
  options: { harness: "pi-ai", model: "claude-opus-4-8" },
})) {
  console.log(message);
}
```

## Python Usage

```bash
pip install lite-harness
```

```python
from lite_harness import query, AgentOptions

prompt = "Fix the failing test"

# Claude Agent SDK harness
async for message in query(
    prompt=prompt,
    options=AgentOptions(harness="claude-agent", model="claude-opus-4-8"),
):
    print(message)

# OpenAI Agents harness
async for message in query(
    prompt=prompt,
    options=AgentOptions(harness="openai-agents", model="gpt-5.5"),
):
    print(message)

# Pi AI harness
async for message in query(
    prompt=prompt,
    options=AgentOptions(harness="pi-ai", model="claude-opus-4-8"),
):
    print(message)
```

## Supported Harnesses

- `claude-agent`: Claude Agent SDK / Claude Code behavior.
  Upstream: [Python](https://github.com/anthropics/claude-agent-sdk-python),
  [TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript).
- `openai-agents`: OpenAI Agents SDK behavior.
  Upstream: [Python](https://github.com/openai/openai-agents-python),
  [TypeScript](https://github.com/openai/openai-agents-js).
- `pi-ai`: Pi AI coding-agent harness.
  Upstream: [GitHub](https://github.com/earendil-works/pi),
  [SDK docs](https://pi.dev/docs/latest/sdk).

## With LiteLLM AI Gateway

Add LiteLLM AI Gateway when you want central keys, budgets, logs, fallbacks, and
provider routing.

```bash
export LITELLM_API_BASE=https://litellm.your-company.com/v1
export LITELLM_API_KEY=sk-litellm-...
```

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Debug this production trace",
  options: {
    harness: "openai-agents",
    model: "anthropic/claude-opus-4-8",
  },
})) {
  console.log(message);
}
```
