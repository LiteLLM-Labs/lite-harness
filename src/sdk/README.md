# lite-harness SDK

One Claude Agent SDK-compatible interface for running coding agents through
lite-harness.

The idea is simple: keep the application API you already know, but run the agent
through your own lite-harness server.

```txt
your app -> lite-harness SDK -> lite-harness server -> Codex / Pi AI / Claude Code
```

The SDK keeps the Claude Agent SDK shape: `query()`, streamed messages, options,
interrupts, model selection, permission modes, and resume.

## Python

Install the Python package:

```bash
pip install lite-agent-sdk
```

### Python: migrate from Claude Agent SDK

Change the import. Keep the rest of the code.

```python
# before
from claude_agent_sdk import query, ClaudeSDKClient, ClaudeAgentOptions

# after
from lite_agent_sdk import query, ClaudeSDKClient, ClaudeAgentOptions
```

### Python: run a query

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="What is 2 + 2?",
    options=ClaudeAgentOptions(
        cwd=".",
        model="claude-sonnet-4-5",
    ),
):
    print(message)
```

### Python: select Codex

Use the same Claude-shaped API, but select the Codex agent runtime on the
lite-harness server.

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Refactor the auth middleware and explain the diff.",
    options=ClaudeAgentOptions(
        cwd=".",
        agent="codex",
        model="gpt-4o",
    ),
):
    print(message)
```

### Python: select Pi AI

Agent names are resolved by the lite-harness server, so a deployed or configured
agent can be selected the same way.

```python
from lite_agent_sdk import query, ClaudeAgentOptions

async for message in query(
    prompt="Review this SDK README and make it sharper.",
    options=ClaudeAgentOptions(
        cwd=".",
        agent="pi-ai",
        model="claude-sonnet-4-5",
    ),
):
    print(message)
```

### Python session control

Python keeps the upstream `ClaudeSDKClient` class.

```python
from lite_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

async with ClaudeSDKClient(
    options=ClaudeAgentOptions(
        cwd=".",
        agent="codex",
        permission_mode="acceptEdits",
    )
) as client:
    await client.query("fix auth.py")

    async for message in client.receive_response():
        print(message)

    await client.set_model("gpt-4o")
    await client.set_permission_mode("default")
    await client.interrupt()
```

## JavaScript / TypeScript

Install the JavaScript package:

```bash
npm install @lite-harness/sdk
```

### JavaScript: migrate from Claude Agent SDK

Change the import. Keep the rest of the code.

```ts
// before
import { query } from "@anthropic-ai/claude-agent-sdk";

// after
import { query } from "@lite-harness/sdk";
```

### JavaScript: run a query

```ts
import { query } from "@lite-harness/sdk";

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

### JavaScript: select Codex

Use the same Claude-shaped API, but select the Codex agent runtime on the
lite-harness server.

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Refactor the auth middleware and explain the diff.",
  options: {
    cwd: ".",
    agent: "codex",
    model: "gpt-4o"
  }
})) {
  console.log(message);
}
```

### JavaScript: select Pi AI

Agent names are resolved by the lite-harness server, so a deployed or configured
agent can be selected the same way.

```ts
import { query } from "@lite-harness/sdk";

for await (const message of query({
  prompt: "Review this SDK README and make it sharper.",
  options: {
    cwd: ".",
    agent: "pi-ai",
    model: "claude-sonnet-4-5"
  }
})) {
  console.log(message);
}
```

### JavaScript session control

In JavaScript and TypeScript, the object returned by `query()` is the session.

```ts
const q = query({
  prompt: "fix auth.py",
  options: {
    cwd: ".",
    agent: "codex",
    permissionMode: "acceptEdits"
  }
});

for await (const message of q) {
  console.log(message);

  if (shouldStop) {
    await q.interrupt();
  }
}

await q.setModel("gpt-4o");
await q.setPermissionMode("default");
await q.close();
```

## What changes vs Claude Agent SDK?

Only the import changes in your app. Agent selection, model routing, tools, and
sandbox policy are handled by the lite-harness server.

| Concern | Claude Agent SDK | lite-harness SDK |
| --- | --- | --- |
| App API | Claude Agent SDK API | Same API |
| Python package | `claude_agent_sdk` | `lite_agent_sdk` |
| JS package | `@anthropic-ai/claude-agent-sdk` | `@lite-harness/sdk` |
| Runtime | Claude Code | lite-harness server |
| Agent selection | Runtime default | `agent: "codex"` / `agent: "pi-ai"` |
| Model routing | SDK/runtime default | LiteLLM gateway |

See [`interface.html`](./interface.html) for the side-by-side API reference.

## Options

The options mirror the Claude Agent SDK naming conventions in each language,
with lite-harness adding server-side agent selection.

```python
ClaudeAgentOptions(
    cwd=".",
    agent="codex",
    model="gpt-4o",
    allowed_tools=["Read", "Edit"],
    system_prompt="You are a senior engineer.",
    mcp_servers={},
    permission_mode="acceptEdits",
    max_turns=10,
    resume=session_id,
)
```

```ts
const options = {
  cwd: ".",
  agent: "codex",
  model: "gpt-4o",
  allowedTools: ["Read", "Edit"],
  systemPrompt: "You are a senior engineer.",
  mcpServers: {},
  permissionMode: "acceptEdits",
  maxTurns: 10,
  resume: sessionId
};
```

## Status

This directory currently contains the SDK contract and interface reference. The
Python and TypeScript packages, plus parity tests against the Claude Agent SDK
surface, follow in subsequent changes.
