/**
 * agent-plugin.mjs — the /agent builder.
 *
 * `/agent` turns a conversation into an autonomous agent:
 *   1. DEFINE   — `/agent` (optionally `/agent <one-liner>`) enters build mode.
 *   2. GRILL    — the backing model interviews the user (live, not scripted) to
 *                 fill the Managed-Agents fields: name, model, system, tools.
 *   3. PROMOTE  — once a spec block is produced, the agent is persisted
 *                 (agent-store) and, if it has a cadence, scheduled via the
 *                 existing loop scheduler (loop-store). A first run fires now.
 *
 * Management:  /agent list | /agent status <id> | /agent stop <id> | /agent cancel
 *
 * Storage mirrors the Anthropic Managed Agents body (name/model/system/tools)
 * plus cadence — see agent-store.mjs. Autonomy reuses loop-store, so this plugin
 * adds an interview + a definition; it does not reimplement scheduling.
 */

import { AdapterPlugin } from "./plugin-registry.mjs";
import { createAgent, getAgent, listAgents, deleteAgent, setAgentLoop } from "./agent-store.mjs";
import { createLoop, deleteLoop } from "./loop-store.mjs";

const DEFAULT_MODEL = process.env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
const DEFAULT_TOOLS = [{ type: "agent_toolset_20260401" }];
const MANAGEMENT_SUBS = new Set(["list", "status", "stop", "cancel", "help"]);

const BUILDER_SYSTEM = `You are the lite-harness Agent Builder. The user wants to create an autonomous agent.
Interview them with short, specific questions to pin down:
  - what the agent does (its job)
  - the system prompt that should drive it
  - which tools it needs
  - how often it runs — a cadence like 30s, 5m, 1h, daily, weekly, or "none" for on-demand
Ask one tight batch of questions at a time. Don't pad.
When — and only when — you have enough AND the user has confirmed, output the final
definition as a fenced code block tagged \`agent-spec\` containing JSON with keys:
  { "name", "model"?, "system", "tools"?, "cadence" }
"tools" is an array of Anthropic tool entries; default [{"type":"agent_toolset_20260401"}].
Output nothing after the agent-spec block.`;

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Parse a cadence string into seconds. Returns null for on-demand markers
 * (none/manual/once/on-demand/"") and for unrecognised input.
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
export function parseCadence(raw) {
  if (raw == null) return null;
  const r = String(raw).trim().toLowerCase();
  if (!r || /^(none|manual|once|on-?demand)$/.test(r)) return null;
  if (r === "daily") return 86400;
  if (r === "weekly") return 604800;
  const m = /^(\d+)(s|m|h)$/.exec(r);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (m[2] === "s") return n;
  if (m[2] === "m") return n * 60;
  return n * 3600;
}

// Returns { type: "interval", seconds } | { type: "cron", expr } | null.
export function parseCadenceFull(raw) {
  if (raw == null) return null;
  const r = String(raw).trim();
  if (!r || /^(none|manual|once|on-?demand)$/i.test(r)) return null;
  // Cron: 5 space-separated fields of digits/*/,-
  if (/^[\d*/,\-]+([ \t]+[\d*/,\-]+){4}$/.test(r)) return { type: "cron", expr: r };
  const seconds = parseCadence(r);
  if (seconds === null) return null;
  return { type: "interval", seconds };
}

/**
 * Split an `/agent ...` line into { sub, args, rest }.
 * @param {string} text
 */
export function parseAgentCommand(text) {
  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] || "").toLowerCase();
  return { sub, args: parts.slice(2), rest: parts.slice(1).join(" ") };
}

/**
 * Extract a fenced ```agent-spec``` (or ```json```) block and parse it.
 * @param {string} text
 * @returns {object|null}
 */
export function extractSpec(text) {
  if (!text) return null;
  const m = /```(?:agent-spec|json)\s*([\s\S]*?)```/i.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

/**
 * Validate + normalise a raw spec into a stored agent record. The first four
 * fields mirror the Managed Agents request body exactly.
 * @param {object} spec
 * @param {{ defaultModel?: string }} [opts]
 * @returns {{ name: string, model: string, system: string, tools: object[],
 *             cadence: string|null, intervalSeconds: number|null }}
 */
export function buildAgentRecord(spec, { defaultModel = DEFAULT_MODEL } = {}) {
  if (!spec || typeof spec !== "object") throw new Error("invalid agent spec");

  const name = String(spec.name || "").trim();
  if (!name) throw new Error("agent spec missing 'name'");

  const system = String(spec.system || "").trim();
  if (!system) throw new Error("agent spec missing 'system'");

  const model = String(spec.model || "").trim() || defaultModel;
  const tools =
    Array.isArray(spec.tools) && spec.tools.length ? spec.tools : DEFAULT_TOOLS;

  const rawCadence = spec.cadence == null ? null : String(spec.cadence).trim();
  const cadenceParsed = parseCadenceFull(rawCadence);
  if (rawCadence && !cadenceParsed && !/^(none|manual|once|on-?demand)$/i.test(rawCadence)) {
    throw new Error(`unknown cadence: ${rawCadence}`);
  }
  const cadence = cadenceParsed ? rawCadence : null;
  const intervalSeconds = cadenceParsed?.type === "interval" ? cadenceParsed.seconds : null;
  const cronExpr = cadenceParsed?.type === "cron" ? cadenceParsed.expr : null;

  return { name, model, system, tools, cadence, intervalSeconds, cronExpr };
}

/** The user message fired into the harness on each scheduled run. */
export function invocationPrompt(rec) {
  return `[Agent: ${rec.name}] ${rec.system}\n\nThis is a scheduled run — carry out your task now and report what you did.`;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export class AgentPlugin extends AdapterPlugin {
  constructor() {
    super();
    /** sessionId → { messages: Array<{role,content}> } */
    this._builds = new Map();
  }

  get name() {
    return "agent";
  }

  setup({ callPromptAsync }) {
    // The shared DB is opened by the adapter's initDb(); no DB work needed here.
    this._callPromptAsync = callPromptAsync;
  }

  matches(text, ctx) {
    const t = text.trim();
    return t.startsWith("/agent") || this._builds.has(ctx.sessionId);
  }

  async handle(text, ctx, emitter) {
    const t = text.trim();

    if (t.startsWith("/agent")) {
      const { sub, args, rest } = parseAgentCommand(t);
      if (MANAGEMENT_SUBS.has(sub)) {
        return this._manage(sub, args, ctx, emitter);
      }
      // Anything else after /agent is an optional one-liner ("new" is stripped).
      const seed = sub === "new" ? args.join(" ") : rest;
      return this._startBuild(seed, ctx, emitter);
    }

    // Mid-interview free text.
    return this._step(text, ctx, emitter);
  }

  async _startBuild(seed, ctx, emitter) {
    this._builds.set(ctx.sessionId, { messages: [] });
    emitter.text("🛠  Agent builder — I'll ask a few questions, then build it. (/agent cancel to abort)");
    const first = seed && seed.trim() ? seed.trim() : "Help me build an agent.";
    return this._step(first, ctx, emitter);
  }

  async _step(userText, ctx, emitter) {
    const build = this._builds.get(ctx.sessionId);
    if (!build) {
      emitter.error("No active agent build. Start one with /agent");
      return;
    }
    build.messages.push({ role: "user", content: userText });

    let reply;
    try {
      reply = await this._complete(build.messages);
    } catch (e) {
      emitter.error(`Builder model call failed: ${e.message}`);
      return;
    }

    const spec = extractSpec(reply);
    if (!spec) {
      build.messages.push({ role: "assistant", content: reply });
      emitter.text(reply);
      emitter.done();
      return;
    }
    return this._finalize(spec, ctx, emitter);
  }

  async _finalize(spec, ctx, emitter) {
    let rec;
    try {
      rec = buildAgentRecord(spec);
    } catch (e) {
      emitter.error(`Bad agent spec: ${e.message}`);
      return;
    }

    let loopId = null;
    if (rec.intervalSeconds !== null || rec.cronExpr !== null) {
      const loop = createLoop({
        sessionId: ctx.sessionId,
        prompt: invocationPrompt(rec),
        intervalSeconds: rec.intervalSeconds ?? null,
        cronExpr: rec.cronExpr ?? null,
      });
      loopId = loop.id;
    }

    const agent = createAgent({ ...rec, sessionId: ctx.sessionId, loopId });
    if (loopId) setAgentLoop(agent.id, loopId);
    this._builds.delete(ctx.sessionId);

    const sched = rec.cadence ? `every ${rec.cadence}` : "on-demand (no schedule)";
    emitter.text(
      [
        `✓ Built agent ${agent.id} — "${rec.name}"`,
        `  model: ${rec.model}`,
        `  runs:  ${sched}`,
        `  manage: /agent status ${agent.id} · /agent stop ${agent.id}`,
        rec.intervalSeconds !== null ? "Doing a first run now…" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    emitter.done();

    // Fire one supervised run immediately so the user sees it work.
    if (rec.intervalSeconds !== null && this._callPromptAsync) {
      this._callPromptAsync(ctx.sessionId, invocationPrompt(rec)).catch((e) =>
        console.error(`[AgentPlugin] first-run error agent=${agent.id}:`, e.message),
      );
    }
  }

  _manage(sub, args, ctx, emitter) {
    if (sub === "cancel") {
      const had = this._builds.delete(ctx.sessionId);
      emitter.text(had ? "✓ Build cancelled." : "No active build to cancel.");
      emitter.done();
      return;
    }

    if (sub === "help") {
      emitter.text(
        [
          "Usage:",
          "  /agent [<one-liner>]     start building an agent (interview)",
          "  /agent list              list agents",
          "  /agent status <id>       show one agent",
          "  /agent stop <id>         delete an agent (and its schedule)",
          "  /agent cancel            abort an in-progress build",
        ].join("\n"),
      );
      emitter.done();
      return;
    }

    if (sub === "list") {
      const agents = listAgents();
      if (agents.length === 0) {
        emitter.text("No agents yet. Build one with /agent");
      } else {
        const header = "ID                   | Name                 | Model                | Cadence";
        const sep = "-".repeat(header.length);
        const rows = agents.map(
          (a) =>
            `${a.id.padEnd(20)} | ${String(a.name).slice(0, 20).padEnd(20)} | ${String(a.model).slice(0, 20).padEnd(20)} | ${a.cadence || "on-demand"}`,
        );
        emitter.text([header, sep, ...rows].join("\n"));
      }
      emitter.done();
      return;
    }

    if (sub === "status") {
      const id = args[0];
      if (!id) {
        emitter.error("Usage: /agent status <id>");
        return;
      }
      const a = getAgent(id);
      if (!a) {
        emitter.error(`Agent not found: ${id}`);
        return;
      }
      emitter.text(
        [
          `ID:       ${a.id}`,
          `Name:     ${a.name}`,
          `Model:    ${a.model}`,
          `Cadence:  ${a.cadence || "on-demand"}`,
          `Scheduled:${a.loop_id ? ` yes (${a.loop_id})` : " no"}`,
          `Tools:    ${JSON.stringify(a.tools)}`,
          `System:   ${a.system}`,
        ].join("\n"),
      );
      emitter.done();
      return;
    }

    if (sub === "stop") {
      const id = args[0];
      if (!id) {
        emitter.error("Usage: /agent stop <id>");
        return;
      }
      const a = getAgent(id);
      if (!a) {
        emitter.error(`Agent not found: ${id}`);
        return;
      }
      if (a.loop_id) deleteLoop(a.loop_id);
      deleteAgent(id);
      emitter.text(`✓ Stopped and removed ${id}`);
      emitter.done();
      return;
    }
  }

  /**
   * Call the gateway (Anthropic Messages format) to advance the interview.
   * Factored out so tests can drive the pure helpers without a network.
   * @param {Array<{role,content}>} messages
   * @returns {Promise<string>} assistant text
   */
  async _complete(messages) {
    const rawBase = (process.env.LITELLM_API_BASE || "").replace(/\/+$/, "");
    if (!rawBase) throw new Error("LITELLM_API_BASE not set");
    const base = /\/v1$/.test(rawBase) ? rawBase : `${rawBase}/v1`;
    const key = process.env.LITELLM_API_KEY || "";

    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        system: BUILDER_SYSTEM,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    return text || "(no response)";
  }
}
