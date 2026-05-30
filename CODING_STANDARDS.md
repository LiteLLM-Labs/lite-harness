# Coding Standards

Concise rules for `lite-harness` (production / infra). Per-directory `AGENTS.md`
files add local detail; this is the baseline they all inherit. When in doubt,
match the surrounding code.

## Language & style

- **Backend is ESM `.mjs`, Node built-ins (`node:*`) + existing deps only.** Don't add a package without cause.
- **Named exports, no default exports.** Imports at module top — no `require`/`import` inside functions (except to break a real cycle).
- **Small, single-purpose files.** A growing file gets split, not appended to. Entry points (dispatchers, barrels) stay thin — wiring only, no logic.
- **Immutable copies via spread** (`{ ...x, k: v }`), not mutate-in-place.
- **Resolve-time guards.** When collapsing a fallback chain (`a || b`), throw immediately if the result being empty is an error — don't pass sentinels downstream.

## Structure

- **One module per concern.** A new entity = a new store; a new tool = a new file (see below). Don't bolt it onto an unrelated module.
- **Layers don't leak.** Tools and routes call into stores; stores own persistence. No SQL in a route or tool handler; no HTTP framing in a store.

## Persistence (SQLite / better-sqlite3)

- **Stores reuse the shared handle** via `getDb()` from `harnesses/loop-store.mjs`; they don't open their own connection. One store file per entity (`*-store.mjs`), all exports synchronous.
- **Schema lives in `loop-store` `init*Schema`.** Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER … ` wrapped in try/catch). Index the columns you filter on.
- **Parameterized queries only** — never string-interpolate values into SQL.
- **Prefer one atomic statement** over read-then-write. Use `INSERT … ON CONFLICT(…) DO UPDATE` for upserts, not a `get()` + branch.

## Platform MCP tools

- **One tool group per file under `mcp/tools/`, registered with `registerTool`; add one import line to the `mcp/tools.mjs` barrel.** Never define a tool in the barrel. See `mcp/AGENTS.md`.
- **Handlers return a plain value**; the server wraps MCP envelopes and serializes errors. Validate inputs and `throw` on bad args.
- **Descriptions are model-facing** — say *when* to call the tool and *what it returns*, not how it's built.

## HTTP API

- **Every `/api/*` route requires the Bearer master key.** No unauthenticated mutation.
- **Validate the body, return the right status** (400 bad input, 404 missing, 422 semantic, 201 created). Match the shape of neighboring routes.

## UI (Next.js)

- **Tailwind + the `ui/src/components/ui` primitives + `lucide-react` icons.** Reuse the existing primitives; don't introduce a second component system.
- **Server calls go through `ui/src/lib/api.ts`** with shared types in `lib/types.ts` — no raw `fetch`/URL building in components.
- **Secrets live in `sessionStorage` only — never `localStorage`** (it survives close and is XSS-readable). Shared helpers belong in `lib/`, not inlined.

## Security

- No secrets in code, logs, or git. No piping remote scripts to a shell; pin and checksum any downloaded tool.
- Treat all agent/model output as untrusted input.

## Tests

- Add or update tests when you add a feature or change a signature; keep test stubs in sync with real signatures (accept new kwargs).
- For name→id resolution, test all branches (resolves+allowed, resolves+denied, no resolve).

## Git & PRs

- **One commit per file** (repo convention). Clear, imperative messages.
- Branch off `main`; commit/push only when asked. Keep unrelated changes out of a PR.
