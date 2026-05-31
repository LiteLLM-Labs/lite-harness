# HarnessSDK — Internal Harness Abstraction

`harnesses/harness-sdk.mjs` is the single place that knows how to talk to each
agent harness. Callers import one `HarnessSDK` instance and call its methods;
they never touch session Maps or child-process HTTP directly.

---

## Why it exists

The adapter manages four harnesses whose session state lives in different places:

| Harness | Message storage |
|---|---|
| `cc` (claude-code) | `ccSessions.get(sid).history` — in-process Map |
| `github-copilot` | `copilotSessions.get(sid).history` — in-process Map |
| `codex` | `codexSessions.get(sid).history` — in-process Map |
| `opencode` | `GET /session/:id/message` — HTTP to child process |

Before this abstraction, callers hard-coded the opencode HTTP path. Agents using
any other harness silently received an empty message list and fell back to
`"Agent run completed: run_xxx"` in Slack replies (discovered in production on
2026-05-31, fixed in PR #124).

---

## API

### Construction

```js
import { HarnessSDK } from "./harness-sdk.mjs";

// Done once in inline-adapter.mjs, after getOcMessages is defined.
const harnessSDK = new HarnessSDK({
  sessionHarness,    // Map<sessionId, harnessType> — the existing `sessionAgent` Map
  ccSessions,        // Map<sessionId, {history: []}>
  copilotSessions,   // Map<sessionId, {history: []}>
  codexSessions,     // Map<sessionId, {history: []}>
  getOcMessages,     // async (sessionId: string) => Message[]
});
```

`sessionHarness` is read live — newly registered sessions are visible
immediately, no re-initialization needed.

---

### `harnessSDK.getMessages(sessionId)` → `Promise<Message[]>`

Returns all messages for a session, regardless of harness type.

```js
const messages = await harnessSDK.getMessages(run.session_id);
```

- For `cc`, `github-copilot`, `codex`: reads the in-process history array. No I/O.
- For `opencode` (or any unregistered session): delegates to `getOcMessages()`.

---

### `harnessSDK.latestAssistantText(messages)` → `string`

Walks a message array in reverse and returns the text of the last assistant
message that has at least one non-empty text part. Returns `""` if none found.

```js
const text = harnessSDK.latestAssistantText(messages);
return { runId, text: text || `Agent run completed: ${runId}` };
```

The message format is the shared wire format used by all harnesses:

```js
{ info: { id, role, finish?, ... }, parts: [{ type, text?, ... }] }
```

---

### `harnessSDK.harnessFor(sessionId)` → `string`

Returns the harness type for a session (`"cc"`, `"opencode"`, etc.), defaulting
to `"opencode"` for unknown sessions.

```js
if (harnessSDK.harnessFor(sid) === "cc") { /* ... */ }
```

---

## Message format

All harnesses write messages in the same wire format so a single
`latestAssistantText()` implementation works across all of them:

```js
{
  info: {
    id:        string,           // message ID
    role:      "user" | "assistant",
    finish?:   "stop" | "error", // present when the turn is complete
    time:      { created: number, completed?: number },
    modelID?:  string,
    harness?:  string,
    error?:    { name, data },
  },
  parts: [
    { type: "text",      text:  string },
    { type: "reasoning", text:  string },
    { type: "tool",      tool:  string, callID: string, state: { input, status, output? } },
  ]
}
```

---

## Adding a new harness

When you add a new harness to the adapter you **must** add a case to
`HarnessSDK.getMessages()`, or the harness will silently fall back to the
opencode HTTP path (which doesn't know about it).

**Step 1** — Add the session Map to the HarnessSDK constructor in
`inline-adapter.mjs`:

```js
const harnessSDK = new HarnessSDK({
  // existing ...
  mySessions,   // ← add this
});
```

**Step 2** — Add it to the `HarnessSDKOptions` typedef and the constructor in
`harness-sdk.mjs`:

```js
constructor({ ..., mySessions }) {
  // existing ...
  this._my = mySessions;
}
```

**Step 3** — Add a `case` in `getMessages()`:

```js
case "my-harness":
  return this._my.get(sessionId)?.history ?? [];
```

The full `contributing-harness.md` guide walks through the rest of what's needed
to wire a new harness end-to-end.

---

## Future methods

The SDK currently covers message retrieval. Three methods would complete the
abstraction and remove the remaining harness-specific code from callers:

| Method | Replaces |
|---|---|
| `sendPrompt(sessionId, prompt)` | `callPromptAsync()` in adapter |
| `waitForCompletion(runId, sid, opts)` | `pollOpencodeRunCompletion()` + cc's synchronous return |
| `createSession(harnessType, agentId, system)` | Per-harness branches in the run handler |

---

## Tests

```bash
# Unit tests (no server needed)
node --test harnesses/harness-sdk.test.mjs

# End-to-end tests (requires running server on :4096)
SKIP_UI_BUILD=1 bash start-local.sh &
node --test harnesses/harness-e2e.test.mjs
```
