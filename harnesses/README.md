# Harnesses

Each subfolder is one supported agent harness. The lite-harness server fronts all of them behind one API.

| Folder | Status |
|---|---|
| `opencode/` | shipped |
| `claude-code/` | in dev (inline adapter + local runner only, no Dockerfile yet) |

Code shared by all harnesses lives in `_shared/` (e.g. `_shared/entrypoint-common.sh`, sourced as `/opt/lap/common.sh` in each harness image).

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
- Pull credentials from env (`LITELLM_API_BASE`, `LITELLM_API_KEY`).
- Discover available models by calling `${LITELLM_API_BASE}/v1/models` at boot.
