# Harness API

One server (`:4096`) fronts both the **opencode** and **claude-code** harnesses.
The HTTP surface is identical for both — only the `harness` field at session-create time differs.

## Base URL

```
http://localhost:4096   # local dev (start-local.sh)
```

---

## Sessions

### Create a session

```http
POST /session
Content-Type: application/json

{
  "title": "my session",
  "harness": "opencode"       // "opencode" (default) | "claude-code"
}
```

**Response**

```json
{
  "id":      "ses_abc123...",
  "title":   "my session",
  "harness": "opencode",
  "time":    { "created": 1700000000000 }
}
```

`harness` is locked for the lifetime of the session — it cannot be changed after creation.

### List sessions

```http
GET /session
```

Returns an array of session objects sorted newest-first, each with a `harness` field.

### Delete a session

```http
DELETE /session/:id
```

---

## Sending messages

### Fire-and-forget (recommended)

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

Returns `204 No Content` immediately. The turn runs in the background; subscribe to `/event` for live output.

### Get message history

```http
GET /session/:id/message
```

Returns the full conversation as an array:

```json
[
  {
    "info": { "id": "msg_...", "role": "user",      "time": { "created": 1700000000000 } },
    "parts": [{ "id": "prt_...", "type": "text", "text": "your prompt" }]
  },
  {
    "info": { "id": "msg_...", "role": "assistant", "time": { "created": 1700000000000, "completed": 1700000003000 },
              "finish": "stop", "tokens": { "input": 10, "output": 42 } },
    "parts": [{ "id": "prt_...", "type": "text", "text": "the reply" }]
  }
]
```

### Abort an in-flight turn

```http
POST /session/:id/abort
```

---

## Streaming events (SSE)

```http
GET /event
```

Server-sent events for all sessions. Filter client-side by `properties.sessionID`.

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
    process.stdout.write(ev.properties.delta);   // live token
  }
  if (ev.type === 'session.idle') {
    es.close();   // turn complete
  }
};
```

---

## Full example: spawn a session and get a reply

```bash
# 1. Create session (opencode or claude-code)
SESSION=$(curl -s -X POST http://localhost:4096/session \
  -H 'content-type: application/json' \
  -d '{"title":"demo","harness":"claude-code"}')
SID=$(echo $SESSION | jq -r '.id')

# 2. Send a message
curl -s -X POST "http://localhost:4096/session/$SID/prompt_async" \
  -H 'content-type: application/json' \
  -d '{
    "model": {"providerID":"litellm","modelID":"anthropic/claude-sonnet-4-5"},
    "parts": [{"type":"text","text":"hello"}]
  }'

# 3. Poll for the reply (or subscribe to /event for streaming)
sleep 10
curl -s "http://localhost:4096/session/$SID/message" | jq '[.[] | {role:.info.role, text:(.parts[]|select(.type=="text").text)}]'
```

---

## Harness comparison

| | opencode | claude-code |
|---|---|---|
| Backend | `opencode serve` child process | `@anthropic-ai/claude-code` SDK in-process |
| Session state | Persisted in opencode's DB | In-memory (lost on restart) |
| Tool use | opencode tool set | Claude Code tool set |
| Working dir | `$REPO_DIR` (opencode harness dir) | `$CC_REPO_DIR` or `$HOME` |
| `harness` value | `"opencode"` | `"claude-code"` |

Both harnesses emit the same SSE event shapes and respond to the same HTTP endpoints.
