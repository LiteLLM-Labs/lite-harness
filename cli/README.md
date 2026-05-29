# lite-harness CLI

Terminal interface for lite-harness. Start TUI chat sessions against any harness from the command line.

## Requirements

- Node.js 18+
- A running lite-harness server

## Install

```bash
# From the repo root
npm install --prefix cli

# Link globally (optional)
npm link --prefix cli
```

Or run directly without installing:

```bash
node cli/bin/lite-harness.mjs <command>
```

## Quick start

```bash
# 1. Save your server URL and master key
lite-harness login

# 2. Start a chat session
lite-harness opencode
```

## Commands

### `login`

Save server URL and master key to `~/.config/lite-harness/config.json`.

```bash
lite-harness login
# Server URL [http://localhost:4096]: 
# Master key (leave empty if none): 
```

Verifies the credentials by calling `/whoami` before saving.

### `list`

Print available harnesses.

```bash
lite-harness list
```

### `models`

List models returned by `/v1/models` on your server.

```bash
lite-harness models
```

### `<harness>`

Start an interactive TUI chat session against a harness.

```bash
lite-harness opencode
lite-harness claude-code
lite-harness github-copilot
lite-harness codex
```

**Flags**

| Flag | Description |
|------|-------------|
| `--model <id>` | Override model. Default: first model from `/v1/models`. |

```bash
lite-harness opencode --model claude-opus-4-8
lite-harness claude-code --model gpt-4o
```

## In-session commands

| Input | Action |
|-------|--------|
| `/clear` | Delete current session and start a fresh one |
| `exit` / `quit` / `\q` | Exit the CLI |
| `Ctrl+C` | Exit the CLI |

## Config file

Credentials are stored at `~/.config/lite-harness/config.json`:

```json
{
  "url": "http://localhost:4096",
  "key": "sk-..."
}
```

Edit this file directly to change server or key without re-running `login`.

## Running against a local server

```bash
# Start the server (from repo root)
./start-local.sh

# In another terminal, log in and chat
lite-harness login   # accept default http://localhost:4096
lite-harness opencode
```

## Example session

```
  lite-harness  opencode
  claude-opus-4-8  ·  localhost:4096  ·  sess_abc123

  /clear to reset history  ·  Ctrl+C or "exit" to quit

❯ write a hello world in python
  ⠋ thinking…
  │ Here's a simple hello world:
  │ 
  │ ```python
  │ print("Hello, world!")
  │ ```

❯ /clear
  ✓ Session cleared  sess_def456

❯ exit
```
