# lite CLI

Terminal interface for lite. Start TUI chat sessions against any harness from the command line.

## Requirements

- Node.js 18+
- A running lite server

## Install

```bash
# From the repo root
npm install --prefix cli

# Link globally (optional)
npm link --prefix cli
```

Or run directly without installing:

```bash
node cli/bin/lite.mjs <command>
```

## Quick start

```bash
# 1. Save your server URL and master key
lite login

# 2. Start a chat session
lite opencode
```

## Commands

### `login`

Save server URL and master key to `~/.config/lite/config.json`.

```bash
lite login
# Server URL [http://localhost:4096]: 
# Master key (leave empty if none): 
```

Verifies the credentials by calling `/whoami` before saving.

### `list`

Print available harnesses.

```bash
lite list
```

### `models`

List models returned by `/v1/models` on your server.

```bash
lite models
```

### `<harness>`

Start an interactive TUI chat session against a harness.

```bash
lite opencode
lite claude-code
lite github-copilot
lite codex
```

**Flags**

| Flag | Description |
|------|-------------|
| `--model <id>` | Override model. Default: first model from `/v1/models`. |

```bash
lite opencode --model claude-opus-4-8
lite claude-code --model gpt-4o
```

## In-session commands

Type `/` to open the slash-command menu. Use `↑`/`↓` to move and `Tab` or `↵`
to autofill the highlighted command.

| Input | Action |
|-------|--------|
| `/loop <interval> <prompt>` | Run a prompt on a repeating interval (`30s`, `5m`, `1h`, `daily`, `weekly`). Also `/loop list`, `/loop status <id>`, `/loop stop <id>` |
| `/vault KEY=VALUE` | Store a secret injected into sandboxes (also `list` / `delete` / `clear`) |
| `/clear` | Delete current session and start a fresh one |
| `/help` | List available commands |
| `exit` / `quit` / `\q` | Exit the CLI |
| `Ctrl+C` | Exit the CLI |

## Config file

Credentials are stored at `~/.config/lite/config.json`:

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
lite login   # accept default http://localhost:4096
lite opencode
```

## Example session

```
  lite  opencode
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
