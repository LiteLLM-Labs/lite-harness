# lite-harness

A drop-in replacement for the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python).
Swap the import and existing code keeps working:

```diff
- from claude_agent_sdk import query, ClaudeSDKClient, ClaudeAgentOptions
+ from lite_harness import query, ClaudeSDKClient, ClaudeAgentOptions
```

The SDK is a thin client. It spawns the lite-harness server as a child process
and speaks newline-delimited JSON-RPC 2.0 over stdio (see `../PROTOCOL.md`).
The server owns the agent runtime, sessions, and tools. **Zero runtime
dependencies** — pure stdlib `asyncio`. Python 3.10+.

## Install

```bash
pip install lite-harness
```

## Usage

One-shot:

```python
import asyncio
from lite_harness import query, ResultMessage

async def main() -> None:
    async for message in query(prompt="Hello"):
        if isinstance(message, ResultMessage):
            print(message.result)

asyncio.run(main())
```

Stateful client (multiple prompts on one session):

```python
from lite_harness import ClaudeSDKClient, ClaudeAgentOptions

async with ClaudeSDKClient(options=ClaudeAgentOptions(model="claude-x")) as client:
    await client.query("first question")
    async for message in client.receive_response():
        ...
    await client.query("follow up")
    async for message in client.receive_response():
        ...
```

## Server command resolution

The spawn command is resolved in order (per `PROTOCOL.md`):

1. an explicit `transport=` argument (tests inject a fake server here),
2. the `LITE_HARNESS_SERVER` env var (a full command line), else
3. the bundled default (`node <server>`).

## lite-harness extension

`ClaudeAgentOptions.harness` (default `"claude"`) selects the server-side agent
runtime. It is sent as a top-level `session/new` param, not inside `options`.
Leaving it at the default keeps full drop-in compatibility.

## Unknown wire shapes

Decoding is centralized in `_decode.py`. Unknown content blocks are skipped;
unknown message types (including `stream_event` partials) fall back to a
`SystemMessage` carrying the raw payload, so newer servers never crash older
clients.
