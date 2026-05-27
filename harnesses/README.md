# Harnesses

Each subfolder is one supported agent harness. The lite-harness server fronts all of them behind one API.

| Folder | Status |
|---|---|
| `opencode/` | shipped |
| `claude-agent-sdk/` | planned |
| `openai-agents/` | planned |

## Adding a new harness

1. Create `harnesses/<name>/` with:
   - `Dockerfile` — builds the harness runtime image
   - `entrypoint.sh` — boots the harness, wires it to LiteLLM
   - `start-local.sh` — runs the harness locally for dev
   - any harness-specific MCP servers or adapters
2. Surface it through the lite-harness API by adding the harness id to the server config.
3. Update the table above.

The contract every harness must satisfy:

- Speak HTTP on `$PORT` for session create / message / event endpoints.
- Pull credentials and model config from env (`LITELLM_API_BASE`, `LITELLM_API_KEY`, `LITELLM_DEFAULT_MODEL`).
- Persist session state so a restart resumes mid-conversation.
