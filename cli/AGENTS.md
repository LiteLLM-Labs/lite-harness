# AGENTS.md — `lite` CLI

Rules for working in this folder. Keep it organized; don't grow one big file.

## Structure

```
bin/lite.mjs        entry — arg parse + command dispatch only
src/
  ansi.mjs          colors, spinner frames, drawBox, terminal helpers
  config.mjs        load/save ~/.config/lite/config.json
  harnesses.mjs     the harness list
  client.mjs        LiteClient — every server HTTP/SSE call
  renderer.mjs      streaming output (Thinking / tool / answer)
  input.mjs         boxedPrompt — raw-mode bordered editor
  commands/         one file per command: login, list, models, chat
```

## Rules

- **`bin/lite.mjs` stays thin.** Only parse argv and dispatch. No business logic.
- **A new command = a new file in `src/commands/`** + one dispatch line in `bin/lite.mjs`. Don't inline it.
- **All server calls go through `LiteClient`** (`src/client.mjs`). No raw `fetch` or URL building in commands.
- **No ANSI escapes inline.** Import from `src/ansi.mjs`; add new colors/helpers there.
- **Terminal UI lives in `ansi` / `renderer` / `input`.** Keep rendering out of command logic.
- **Zero dependencies.** Node 18+ built-ins only (`node:*`). Don't add a package.
- **ESM, `.mjs`.** Named exports, no default exports.
