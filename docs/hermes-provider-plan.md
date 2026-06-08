# Hermes Provider — Implementation Reference

## What was built

A new provider `hermes` that drives `@openai/agents` against any OpenAI-compatible
local endpoint (Ollama, vLLM, LiteLLM). It mirrors the `codex` provider pattern,
reuses `codex/transformation.mjs` directly, and auto-registers via the provider
discovery system — no wiring changes required.

---

## Files changed

```
src/sdk/server/providers/
└── hermes/
    └── index.mjs                                     ← new provider

tests/src/sdk/server/providers/
├── hermes/
│   └── index.test.mjs                                ← new unit tests
└── index.test.mjs                                    ← updated: added hermes assertions
```

---

## Provider contract

| Export | Value |
|---|---|
| `id` | `"hermes"` |
| `aliases` | `["nous-hermes", "hermes-agent"]` |
| `createRuntime` | factory — see below |

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HERMES_API_BASE` | **yes** | — | Base URL of your Hermes-compatible server |
| `HERMES_API_KEY` | no | `"ollama"` | API key (Ollama doesn't need one; vLLM may) |
| `HERMES_DEFAULT_MODEL` | no | — | Model name used when `--model` is not passed |

`createRuntime` throws immediately with a clear error if `HERMES_API_BASE` is missing.

---

## Setup for manual testing

### Option A — Ollama (recommended for local testing)

**1. Install Ollama**

Download from https://ollama.com and verify it's running:

```bash
ollama --version
```

**2. Pull a Hermes model**

```bash
ollama pull nous-hermes2
```

Lighter alternative (2 GB):
```bash
ollama pull nous-hermes2:10.7b-solar-q4_K_M
```

**3. Start Ollama** (if not already running as a service)

```bash
ollama serve
# Listens on http://localhost:11434 by default
```

**4. Verify it's responding**

```bash
curl http://localhost:11434/v1/models
# Should return a JSON list containing your pulled models
```

---

### Option B — vLLM

**1. Install vLLM**

```bash
pip install vllm
```

**2. Serve a Hermes model**

```bash
vllm serve NousResearch/Hermes-3-Llama-3.1-8B --port 8000
```

**3. Verify it's responding**

```bash
curl http://localhost:8000/v1/models
```

---

### Install project dependencies (one-time)

```bash
cd src/sdk/server && npm install
```

---

## Running the server

```bash
HERMES_API_BASE=http://localhost:11434 \
node src/sdk/server/server.mjs \
  --input-format stream-json \
  --output-format stream-json \
  --agent hermes \
  --model nous-hermes2
```

For vLLM change the base URL and model name:

```bash
HERMES_API_BASE=http://localhost:8000 \
node src/sdk/server/server.mjs \
  --input-format stream-json \
  --output-format stream-json \
  --agent hermes \
  --model NousResearch/Hermes-3-Llama-3.1-8B
```

For aliases (`nous-hermes` and `hermes-agent` both resolve to the same provider):

```bash
HERMES_API_BASE=http://localhost:11434 \
node src/sdk/server/server.mjs \
  --input-format stream-json \
  --output-format stream-json \
  --agent nous-hermes \
  --model nous-hermes2
```

---

## Use cases for manual testing

The wire protocol is NDJSON on stdio. Each input is one JSON line sent to stdin;
output frames arrive on stdout as they are produced.

---

### Use case 1 — Basic identity check

Verify the provider connects and the model responds.

```bash
echo '{"type":"user","request_id":"r1","message":{"content":[{"type":"text","text":"Who are you? Answer in one sentence."}]}}' | \
  HERMES_API_BASE=http://localhost:11434 \
  node src/sdk/server/server.mjs \
    --input-format stream-json \
    --output-format stream-json \
    --agent hermes \
    --model nous-hermes2
```

**Expected output (NDJSON, one frame per line):**

```
{"type":"system","subtype":"init","session_id":"<id>","model":"nous-hermes2",...}
{"type":"stream_event","session_id":"<id>","event":{"type":"content_block_delta",...}}
... (one stream_event per token)
{"type":"assistant","message":{"model":"nous-hermes2","content":[{"type":"text","text":"..."}]},...}
{"type":"result",...}
```

---

### Use case 2 — Code generation

Verify the model can produce code and the full response is captured.

```bash
echo '{"type":"user","request_id":"r2","message":{"content":[{"type":"text","text":"Write a JavaScript function that reverses a string."}]}}' | \
  HERMES_API_BASE=http://localhost:11434 \
  node src/sdk/server/server.mjs \
    --input-format stream-json \
    --output-format stream-json \
    --agent hermes \
    --model nous-hermes2
```

**What to verify:** the `assistant` frame's `content[0].text` contains a valid JS function.

---

### Use case 3 — Model passed through as-is (vLLM format)

Verify the provider does not transform the model name — vLLM expects the full HuggingFace path.

```bash
echo '{"type":"user","request_id":"r3","message":{"content":[{"type":"text","text":"Say hello."}]}}' | \
  HERMES_API_BASE=http://localhost:8000 \
  node src/sdk/server/server.mjs \
    --input-format stream-json \
    --output-format stream-json \
    --agent hermes \
    --model NousResearch/Hermes-3-Llama-3.1-8B
```

**What to verify:** the `assistant` frame shows `"model":"NousResearch/Hermes-3-Llama-3.1-8B"` unchanged.

---

### Use case 4 — Missing HERMES_API_BASE produces a clear error

Confirm the provider fails fast instead of silently misconfiguring.

```bash
echo '{"type":"user","request_id":"r4","message":{"content":[{"type":"text","text":"Hello"}]}}' | \
  node src/sdk/server/server.mjs \
    --input-format stream-json \
    --output-format stream-json \
    --agent hermes \
    --model nous-hermes2
```

**Expected:** process exits with a message containing `HERMES_API_BASE is required`.

---

### Use case 5 — HERMES_DEFAULT_MODEL fallback (no --model flag)

Verify the env var default works when `--model` is omitted.

```bash
echo '{"type":"user","request_id":"r5","message":{"content":[{"type":"text","text":"Say hello."}]}}' | \
  HERMES_API_BASE=http://localhost:11434 \
  HERMES_DEFAULT_MODEL=nous-hermes2 \
  node src/sdk/server/server.mjs \
    --input-format stream-json \
    --output-format stream-json \
    --agent hermes
```

**What to verify:** `system` init frame shows `"model":"nous-hermes2"`.

---

### Use case 6 — Interactive multi-turn session

Start the server, then paste frames line by line to simulate a conversation.

```bash
HERMES_API_BASE=http://localhost:11434 \
node src/sdk/server/server.mjs \
  --input-format stream-json \
  --output-format stream-json \
  --agent hermes \
  --model nous-hermes2
```

Then paste these lines one at a time (press Enter after each):

```
{"type":"user","request_id":"r1","message":{"content":[{"type":"text","text":"My name is Jean."}]}}
{"type":"user","request_id":"r2","message":{"content":[{"type":"text","text":"What is my name?"}]}}
```

**What to verify:** the second response references the name from the first turn.

---

### Use case 7 — Alias resolution (no model server needed)

Verify all three identifiers (`hermes`, `nous-hermes`, `hermes-agent`) resolve to the same provider without starting Ollama or vLLM.

```bash
node --input-type=module -e "
import { resolveProvider } from './src/sdk/server/providers/index.mjs';
const hermes = await resolveProvider('hermes');
const alias1 = await resolveProvider('nous-hermes');
const alias2 = await resolveProvider('hermes-agent');
console.log('id:', hermes.id);
console.log('nous-hermes === hermes:', alias1 === hermes);
console.log('hermes-agent === hermes:', alias2 === hermes);
"
```

**Expected output:**

```
id: hermes
nous-hermes === hermes: true
hermes-agent === hermes: true
```

---

## Automated test suite

```bash
cd src/sdk/server && npm test
```

All 32 tests should pass. The hermes-specific tests cover:
- `createRuntime` throws when `HERMES_API_BASE` is missing
- `model` getter returns the value passed in
- `setModel` updates the model
- `setModel` ignores falsy values
- Provider registry resolves `hermes`, `nous-hermes`, and `hermes-agent` to the same module
