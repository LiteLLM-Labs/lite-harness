# lite-harness SDK

Call every implemented agent harness using one SDK: Claude Agent SDK and OpenAI
Agents.

lite-harness SDK manages:

- One JavaScript and Python interface for multiple agent harnesses
- Harness switching with `harness`, model switching with `model`
- Claude Agent SDK-compatible streaming messages and errors
- Optional LiteLLM AI Gateway routing for keys, budgets, logs, and fallbacks

No gateway is required. Use provider-native API keys by default.

> Preview: the SDK is not published to npm or PyPI yet. Clone this repo to try
> it. If you want a packaged release, please
> [file an issue](https://github.com/LiteLLM-Labs/lite-harness/issues).

## JavaScript Usage

```bash
git clone https://github.com/LiteLLM-Labs/lite-harness.git
cd lite-harness
```

```ts
import { query } from "@lite-harness/sdk";

const prompt = "Fix the failing test";

// Claude Agent SDK harness
for await (const message of query({
  prompt,
  options: { harness: "claude", model: "claude-opus-4-8" },
})) {
  console.log(message);
}

// OpenAI Agents harness
for await (const message of query({
  prompt,
  options: { harness: "openai", model: "gpt-5.5" },
})) {
  console.log(message);
}
```

## Python Usage

```bash
git clone https://github.com/LiteLLM-Labs/lite-harness.git
cd lite-harness
export PYTHONPATH="$PWD/src/sdk/python:$PYTHONPATH"
```

```python
from lite_harness import query, AgentOptions

prompt = "Fix the failing test"

# Claude Agent SDK harness
async for message in query(
    prompt=prompt,
    options=AgentOptions(harness="claude", model="claude-opus-4-8"),
):
    print(message)

# OpenAI Agents harness
async for message in query(
    prompt=prompt,
    options=AgentOptions(harness="openai", model="gpt-5.5"),
):
    print(message)
```

## Supported Harnesses

- `claude`: Claude Agent SDK / Claude Code behavior.
  Upstream: [Python](https://github.com/anthropics/claude-agent-sdk-python),
  [TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript).
- `openai`: OpenAI Agents SDK behavior.
  Upstream: [Python](https://github.com/openai/openai-agents-python),
  [TypeScript](https://github.com/openai/openai-agents-js).

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
    harness: "openai",
    model: "anthropic/claude-opus-4-8",
  },
})) {
  console.log(message);
}
```

## MCP access

Pass MCP servers in `AgentOptions` when the selected harness should have access
to external tools. For HTTP MCP servers, provide the endpoint URL and any
headers the server requires.

Python:

```python
from lite_harness import query, AgentOptions

async for message in query(
    prompt="Use the docs MCP to answer this.",
    options=AgentOptions(
        harness="claude",
        model="claude-opus-4-8",
        mcp_servers={
            "docs": {
                "type": "http",
                "url": "https://example.com/mcp",
                "headers": {
                    "Authorization": "Bearer your-token",
                },
            }
        },
    ),
):
    print(message)
```

JavaScript:

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Use the docs MCP to answer this.",
  options: {
    harness: "claude",
    model: "claude-opus-4-8",
    mcpServers: {
      docs: {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer your-token"
        }
      }
    }
  }
})) {
  console.log(message);
}
```
