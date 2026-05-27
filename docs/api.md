# Harness API

The lite-harness server implements a subset of the **[opencode server API](https://opencode.ai/docs/server)** — the same HTTP contract `opencode serve` exposes on `:4096`. Any client that speaks the opencode protocol works against both the `opencode` and `claude-code` harnesses without modification.

The one addition beyond the opencode spec: a `harness` field on `POST /session` and in session responses.

## Base URL

```
http://localhost:4096   # local dev (start-local.sh)
```

---

## Opencode-compatible endpoints

These follow the [opencode server spec](https://opencode.ai/docs/server) verbatim.

### Sessions

```http
GET    /session                 # list sessions → Session[]
POST   /session                 # create session → Session
GET    /session/:id             # get session → Session
DELETE /session/:id             # delete session → boolean
```

### Messages

```http
GET  /session/:id/message          # list messages → {info, parts}[]
POST /session/:id/message          # send message (sync, blocks until reply)
POST /session/:id/prompt_async     # send message (async, returns 204 immediately)
POST /session/:id/abort            # cancel in-flight turn
```

### Events (SSE)

```http
GET /event    # SSE bus — same event shapes as opencode
```

---

## lite-harness extension: `harness` field

`POST /session` accepts one extra field not in the opencode spec:

```http
POST /session
Content-Type: application/json

{
  "title":   "my session",
  "harness": "opencode"       // "opencode" (default) | "claude-code"
}
```

The `harness` field is also present in every session response:

```json
{
  "id":      "ses_abc123...",
  "title":   "my session",
  "harness": "opencode",
  "time":    { "created": 1700000000000 }
}
```

`harness` is immutable after the first message is sent.

---

## Sending messages

### Async (recommended)

```http
POST /session/:id/prompt_async
Content-Type: application/json

{
  "model": {
    "providerID": "litellm",
    "modelID":    "anthropic/claude-sonnet-4-5"
  },
  "parts": [
    { "type": "text", "text": "your prompt here" }
  ]
}
```

Returns `204 No Content` immediately. Subscribe to `/event` for live output.

### Sync

```http
POST /session/:id/message
```

Same body. Blocks until the full reply is ready.

### Get message history

```http
GET /session/:id/message
```

```json
[
  {
    "info":  { "id": "msg_...", "role": "user",      "time": { "created": 1700000000000 } },
    "parts": [{ "id": "prt_...", "type": "text", "text": "your prompt" }]
  },
  {
    "info":  { "id": "msg_...", "role": "assistant", "finish": "stop",
               "time": { "created": 1700000000000, "completed": 1700000003000 },
               "tokens": { "input": 10, "output": 42 } },
    "parts": [{ "id": "prt_...", "type": "text", "text": "the reply" }]
  }
]
```

---

## Streaming events (SSE)

```http
GET /event
```

Follows the opencode SSE protocol. Filter client-side on `properties.sessionID`.

### Event types

| Type | Fired when | Key properties |
|---|---|---|
| `server.connected` | SSE connection established | — |
| `message.updated` | Message created or completed | `info` (id, role, finish, tokens) |
| `message.part.updated` | Part created or finalized | `messageID`, `part` (id, type, text) |
| `message.part.delta` | Token streamed | `messageID`, `partID`, `field`, `delta` |
| `session.status` | Agent becomes busy/idle | `status.type` ("busy"\|"idle") |
| `session.idle` | Turn finished | `sessionID` |

### Streaming example

```js
const es = new EventSource('http://localhost:4096/event');
es.onmessage = ({ data }) => {
  const ev = JSON.parse(data);
  if (ev.properties?.sessionID !== MY_SESSION_ID) return;

  if (ev.type === 'message.part.delta' && ev.properties.field === 'text') {
    process.stdout.write(ev.properties.delta);
  }
  if (ev.type === 'session.idle') es.close();
};
```

---

## Full example: spawn a session and stream a reply

```bash
# 1. Create session — pick harness here, locked for life of session
SESSION=$(curl -s -X POST http://localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title":"demo","harness":"claude-code"}')
SID=$(echo $SESSION | jq -r '.id')

# 2. Subscribe to events before sending (avoids missing early tokens)
curl -sN "http://localhost:4096/event" &

# 3. Send a message (async)
curl -s -X POST "http://localhost:4096/session/$SID/prompt_async" \
  -H 'content-type: application/json' \
  -d '{
    "model": {"providerID":"litellm","modelID":"anthropic/claude-sonnet-4-5"},
    "parts": [{"type":"text","text":"hello"}]
  }'

# 4. Or poll for the reply
sleep 10
curl -s "http://localhost:4096/session/$SID/message" \
  | jq '[.[] | {role:.info.role, text:(.parts[]|select(.type=="text").text)}]'
```

---

## Harness comparison

| | `opencode` | `claude-code` |
|---|---|---|
| **Backend** | `opencode serve` child process | `@anthropic-ai/claude-code` SDK in-process |
| **Session persistence** | opencode's SQLite DB (survives restart) | In-memory (lost on restart) |
| **Tool set** | opencode tools | Claude Code tools |
| **Working dir** | `$REPO_DIR` | `$CC_REPO_DIR` or `$HOME` |
| **opencode spec coverage** | Full | Sessions + messages + events only |

Both emit identical SSE event shapes and accept the same HTTP request bodies.

---

## Not yet implemented

The following opencode spec endpoints are not exposed by lite-harness (proxied to the opencode child for `opencode` sessions only, not available for `claude-code` sessions):

`/global/health`, `/project`, `/config`, `/provider`, `/find`, `/file`, `/lsp`, `/mcp`, `/agent`, `/tui/*`
