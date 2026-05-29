/**
 * agent-plugin.mjs — server side of the /agent builder.
 *
 * The interview ("grilling") happens in the CLI (cli/src/agent-build.mjs); the
 * server stays deterministic and never calls a model. It accepts a finished
 * definition and does the persistent work:
 *
 *   /agent save <json>     persist the definition, schedule it (if it has a
 *                          cadence) via the existing loop scheduler, run once now
 *   /agent list            list agents
 *   /agent status <id>     show one agent
 *   /agent stop <id>       delete an agent (and its schedule)
 *
 * <json> mirrors the Anthropic Managed Agents body (name/model/system/tools)
 * plus cadence — see agent-store.mjs. Autonomy reuses loop-store, so this plugin
 * adds a definition + a save path; it does not reimplement scheduling.
 */

import { AdapterPlugin } from "./plugin-registry.mjs";
import { createAgent, getAgent, listAgents, deleteAgent, setAgentLoop } from "./agent-store.mjs";
import { createLoop, deleteLoop } from "./loop-store.mjs";

const DEFAULT_MODEL = process.env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
const DEFAULT_TOOLS = [{ type: "agent_toolset_20260401" }];

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

/**
 * Split an `/agent ...` line into { sub, args, rest }. Not used for `save`,
 * whose JSON payload is sliced raw so whitespace survives.
 * @param {string} text
 */
export function parseAgentCommand(text) {
  const parts = text.trim().split(/\s+/);
  const sub = (parts[1] || "").toLowerCase();
  return { sub, args: parts.slice(2), rest: parts.slice(1).join(" ") };
}

/**
 * Validate + normalise a definition into a stored agent record. The first four
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
  const intervalSeconds = parseCadence(rawCadence);
  if (rawCadence && intervalSeconds === null && !/^(none|manual|once|on-?demand)$/i.test(rawCadence)) {
    throw new Error(`unknown cadence: ${rawCadence}`);
  }
  const cadence = intervalSeconds === null ? null : rawCadence;

  return { name, model, system, tools, cadence, intervalSeconds };
}

/** The user message fired into the harness on each scheduled run. */
export function invocationPrompt(rec) {
  return `[Agent: ${rec.name}] ${rec.system}\n\nThis is a scheduled run — carry out your task now and report what you did.`;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export class AgentPlugin extends AdapterPlugin {
  get name() {
    return "agent";
  }

  setup({ callPromptAsync }) {
    // The shared DB is opened by the adapter's initDb(); no DB work needed here.
    this._callPromptAsync = callPromptAsync;
  }

  matches(text) {
    return text.trim().startsWith("/agent");
  }

  async handle(text, ctx, emitter) {
    const t = text.trim();

    // /agent save <json> — the CLI sends the finished definition here. Slice the
    // payload raw (don't tokenise) so JSON whitespace survives.
    const save = /^\/agent\s+save\s+([\s\S]+)$/i.exec(t);
    if (save) return this._save(save[1], ctx, emitter);

    const { sub, args } = parseAgentCommand(t);
    if (sub === "list") return this._list(emitter);
    if (sub === "status") return this._status(args[0], emitter);
    if (sub === "stop") return this._stop(args[0], emitter);

    // Bare /agent (or unknown) — building is a CLI flow; hint if reached directly.
    emitter.text(
      [
        "Usage (build from the CLI): just type /agent",
        "  /agent list            list agents",
        "  /agent status <id>     show one agent",
        "  /agent stop <id>       delete an agent and its schedule",
      ].join("\n"),
    );
    emitter.done();
  }

  _save(payload, ctx, emitter) {
    let spec;
    try {
      spec = JSON.parse(payload);
    } catch {
      emitter.error("save: invalid JSON payload");
      return;
    }

    let rec;
    try {
      rec = buildAgentRecord(spec);
    } catch (e) {
      emitter.error(`Bad agent definition: ${e.message}`);
      return;
    }

    let loopId = null;
    if (rec.intervalSeconds !== null) {
      const loop = createLoop({
        sessionId: ctx.sessionId,
        prompt: invocationPrompt(rec),
        intervalSeconds: rec.intervalSeconds,
      });
      loopId = loop.id;
    }

    const agent = createAgent({ ...rec, sessionId: ctx.sessionId, loopId });
    if (loopId) setAgentLoop(agent.id, loopId);

    const sched = rec.cadence ? `every ${rec.cadence}` : "on-demand (no schedule)";
    emitter.text(
      [
        `✓ Created agent ${agent.id} — "${rec.name}"`,
        `  model: ${rec.model}`,
        `  runs:  ${sched}`,
        `  manage: /agent status ${agent.id} · /agent stop ${agent.id}`,
        rec.intervalSeconds !== null ? "Running once now…" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    emitter.done();

    if (rec.intervalSeconds !== null && this._callPromptAsync) {
      this._callPromptAsync(ctx.sessionId, invocationPrompt(rec)).catch((e) =>
        console.error(`[AgentPlugin] first-run error agent=${agent.id}:`, e.message),
      );
    }
  }

  _list(emitter) {
    const agents = listAgents();
    if (agents.length === 0) {
      emitter.text("No agents yet. Build one by typing /agent");
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
  }

  _status(id, emitter) {
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
        `ID:        ${a.id}`,
        `Name:      ${a.name}`,
        `Model:     ${a.model}`,
        `Cadence:   ${a.cadence || "on-demand"}`,
        `Scheduled: ${a.loop_id ? `yes (${a.loop_id})` : "no"}`,
        `Tools:     ${JSON.stringify(a.tools)}`,
        `System:    ${a.system}`,
      ].join("\n"),
    );
    emitter.done();
  }

  _stop(id, emitter) {
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
  }
}
