# Adding a New Harness

A harness wraps an agent backend (an SDK, CLI, or child process) and exposes it
through the unified adapter's HTTP surface. This guide walks through everything
you need to add one without breaking the build or the UI.

---

## 1. Create the harness directory

```
harnesses/<name>/
  package.json        ← harness-specific deps (SDK, etc.)
  inline-adapter.mjs  ← standalone HTTP server (optional — for standalone mode)
  start-local.sh      ← local dev runner
```

The unified adapter (`harnesses/opencode/inline-adapter.mjs`) is the single
entry point in production. Your harness code runs **inside** that adapter, not
as a separate process.

---

## 2. Install your SDK deps locally

```bash
cd harnesses/<name>
npm install
```

The unified adapter loads your SDK via a relative path:

```js
const sdkPath = _require.resolve("../<name>/node_modules/your-sdk");
```

This works in local dev because `harnesses/<name>/node_modules/` exists on disk.

---

## 3. Add a build stage to the Dockerfile

**This is the step most likely to be missed.**

The Docker image doesn't automatically include `harnesses/<name>/node_modules/`.
You must add an explicit build stage and COPY it in.

Open the root `Dockerfile` and add:

```dockerfile
# ============================================================== <name> SDK
FROM node:20-bookworm-slim AS <name>-deps
WORKDIR /<name>
COPY harnesses/<name>/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
```

Then in the **runtime** stage, add a COPY that mirrors the local-dev path
(the adapter resolves from `/opt/lap/`, so `../<name>/` = `/opt/<name>/`):

```dockerfile
COPY --from=<name>-deps --chown=sandbox:sandbox /<name>/node_modules /opt/<name>/node_modules
```

If you skip this, the adapter logs `<name> SDK not available` at boot and
`POST /session {"harness":"<name>"}` returns `503`.

---

## 4. Wire routing in the unified adapter

In `harnesses/opencode/inline-adapter.mjs`:

### Load your SDK (top-level, after existing SDK loads)

```js
let myQuery;
try {
  const sdkPath = _require.resolve("../<name>/node_modules/your-sdk");
  myQuery = (await import(sdkPath)).query;
  log("<name> SDK loaded");
} catch (e) {
  log(`<name> SDK not available: ${e.message}`);
}
```

### Add session state

```js
const mySessions = new Map();   // id → { id, title, time, history, busSubscribers, ... }
const myGlobalBus = new Set();  // SSE writers
```

### POST /session — handle your harness value

```js
if (harness === "<name>") {
  if (!myQuery) { res.writeHead(503); res.end(JSON.stringify({ error: "<name> SDK not available" })); return; }
  const id = `ses_${randomUUID().replace(/-/g,"").slice(0,24)}`;
  const s = { id, title: body.title || "New session", time: { created: Date.now() }, history: [], busSubscribers: new Set() };
  mySessions.set(id, s);
  sessionHarness.set(id, "<name>");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id, title: s.title, time: s.time, harness: "<name>" }));
  return;
}
```

### Route prompt_async and GET message

In the `isMessagePath` block, add a check before the opencode fallthrough:

```js
if (sid && sessionHarness.get(sid) === "<name>") {
  // handle in-process
}
```

### Emit SSE events

Emit the same shapes as opencode/cc so the UI works without changes:

```js
myEmit(sessionId, "message.part.delta", { messageID, partID, field: "text", delta });
myEmit(sessionId, "session.idle", {});
```

**Critical**: emit `message.part.updated` with `text: ""` on `content_block_start`
(or equivalent) **before** any deltas. The UI's delta handler looks up the part
by ID and silently drops deltas if the part doesn't exist yet.

### Wire your bus into GET /event

In the `/event` SSE handler, register your global bus alongside the existing cc bus:

```js
const myPush = (line) => { try { res.write(line); } catch {} };
myGlobalBus.add(myPush);
req.on("close", () => myGlobalBus.delete(myPush));
```

---

## 5. Extend the UI types

In `ui/src/lib/types.ts`, add your harness ID to the union:

```ts
export interface OpencodeSession {
  harness?: "opencode" | "claude-code" | "<name>";
  // ...
}
```

And in `ui/src/components/sidebar.tsx` + `ui/src/app/chat/page.tsx` / `sessions/page.tsx`,
add a `SelectItem` for it.

---

## 6. Rebuild the UI and commit

```bash
cd ui && npm run build
git add Dockerfile harnesses/<name>/ ui/src/ ui/out/
git commit -m "feat(harness): add <name>"
```

---

## Checklist

- [ ] `harnesses/<name>/package.json` exists
- [ ] `harnesses/<name>/node_modules/` installed locally (`npm install`) — skip if no deps
- [ ] Dockerfile has a `<name>-deps` build stage — skip if no npm deps (use native fetch instead)
- [ ] Dockerfile copies node_modules to `/opt/<name>/node_modules/` in runtime stage — skip if no deps
- [ ] Adapter loads SDK with try/catch, logs failure gracefully
- [ ] `POST /session {"harness":"<name>"}` returns `503` when SDK unavailable, `200` when available
- [ ] `prompt_async` routes to your in-process handler
- [ ] `GET /session/:id/message` returns your session's history
- [ ] SSE events emitted: `message.part.updated` (empty) before first delta, `session.idle` on completion
- [ ] Your bus registered in the `/event` multiplexer
- [ ] UI types updated, `SelectItem` added, UI rebuilt
- [ ] Tested locally with `start-local.sh` before pushing

---

## BYOK / LiteLLM Proxy Support

Harnesses that call an LLM API should support BYOK (Bring Your Own Key) so users can route
traffic through a LiteLLM proxy instead of hitting the upstream provider directly.

### Pattern

Read two standard env vars before constructing your endpoint:

```js
const byokBase = process.env.LITELLM_API_BASE;  // e.g. http://localhost:4000/v1
const byokKey  = process.env.LITELLM_API_KEY;   // your LiteLLM master or virtual key

if (byokBase) {
  // BYOK mode — route to LiteLLM, no provider auth needed
  url = byokBase.replace(/\/+$/, "") + "/chat/completions";
  key = byokKey || "";
} else {
  // Native mode — use provider-specific auth (token exchange, etc.)
  url  = "https://api.provider.com/chat/completions";
  key  = await getProviderToken();
}
```

### Session guard

Return `503` only when **neither** BYOK nor native credentials are present:

```js
if (!process.env.LITELLM_API_BASE && !process.env.PROVIDER_TOKEN) {
  res.writeHead(503);
  res.end(JSON.stringify({ error: "<name> requires LITELLM_API_BASE (BYOK) or PROVIDER_TOKEN (native)" }));
  return;
}
```

### Usage

```bash
# BYOK — point at a running LiteLLM proxy
export LITELLM_API_BASE=http://localhost:4000/v1
export LITELLM_API_KEY=sk-...
# select the harness in the UI — no upstream provider credentials needed

# Native — use the upstream provider directly
export GITHUB_TOKEN=ghp_...     # (example for github-copilot harness)
```

### Why this matters

- Teams running LiteLLM already have model routing, rate limits, and audit logs configured.
- BYOK lets any harness benefit from that without code changes per provider.
- `LITELLM_API_BASE` and `LITELLM_API_KEY` are already set in many deployments, so
  harnesses that check them "just work" without additional configuration.
