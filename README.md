# lite-harness

Call all implemented agent harnesses using the Claude Agent SDK format: Claude
Agent SDK and OpenAI Agents.

lite-harness manages:

- One TypeScript and Python interface for multiple agent harnesses
- Harness switching with `harness`, model switching with `model`
- Claude Agent SDK-compatible streaming messages and errors

> Preview: the SDK is not published to npm or PyPI yet. Clone this repo to try
> it. If you want a packaged release, please
> [file an issue](https://github.com/LiteLLM-Labs/lite-harness/issues).

[![Discord](https://img.shields.io/badge/Discord-Chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/Nkxw3rm3EE)

## Setup (clone)

```bash
git clone https://github.com/LiteLLM-Labs/lite-harness.git
cd lite-harness

# install the backend server's deps once — the SDK auto-spawns it from the clone
npm install --prefix src/sdk/server

# pick a model — set the key for your provider:
export ANTHROPIC_API_KEY=sk-ant-...   # for harness "claude-code"
export OPENAI_API_KEY=sk-...          # for harness "codex"
# …or point at a LiteLLM gateway instead:
#   export LITELLM_API_BASE=https://litellm.your-company.com/v1
#   export LITELLM_API_KEY=sk-litellm-...
```

## TypeScript Usage

```bash
npm install --prefix src/sdk/typescript && npm run build --prefix src/sdk/typescript
# import "@lite-harness/sdk" from your project after `npm link`, or from dist/
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
pip install -e src/sdk/python      # editable install of the client (Python 3.10+)
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

## Docs

[SDK](src/sdk/README.md)

## License

MIT
