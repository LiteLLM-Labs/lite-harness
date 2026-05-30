import { Cron } from "croner";
import { AdapterPlugin } from "./plugin-registry.mjs";
import {
  initDb,
  createLoop,
  dueLoops,
  tickLoop,
  deleteLoop,
  listLoops,
  getLoop,
} from "./loop-store.mjs";
import { getSessionTz } from "./session-store.mjs";

// Returns { type: "interval", seconds } or { type: "cron", expr } or null.
function parseSchedule(raw) {
  if (!raw) return null;
  const r = raw.trim();
  // Cron: 5 space-separated fields of digits/*/,-
  if (/^[\d*/,\-]+([ \t]+[\d*/,\-]+){4}$/.test(r)) return { type: "cron", expr: r };
  if (r === "daily") return { type: "interval", seconds: 86400 };
  if (r === "weekly") return { type: "interval", seconds: 604800 };
  const m = /^(\d+)(s|m|h)$/.exec(r);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const seconds = m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
  return { type: "interval", seconds };
}

function computeNextRunAt(loop) {
  if (loop.cron_expr) {
    const job = new Cron(loop.cron_expr, { timezone: loop.tz || "UTC", paused: true });
    const next = job.nextRun();
    return next ? next.getTime() : Date.now() + 60_000;
  }
  return Date.now() + loop.interval_seconds * 1000;
}

function scheduleLabel(loop) {
  return loop.cron_expr
    ? `cron(${loop.cron_expr})${loop.tz ? " " + loop.tz : ""}`
    : `${loop.interval_seconds}s`;
}

export class LoopPlugin extends AdapterPlugin {
  get name() {
    return "loop";
  }

  setup({ callPromptAsync, isSessionActive, dbPath }) {
    initDb(dbPath);
    this._callPromptAsync = callPromptAsync;
    this._isSessionActive = isSessionActive;
    const timer = setInterval(() => this._tick(), 10_000);
    timer.unref();
  }

  matches(text, _ctx) {
    return text.trim().startsWith("/loop");
  }

  async handle(text, ctx, emitter) {
    const parts = text.trim().split(/\s+/);
    const sub = parts[1];

    if (sub === "stop") {
      const id = parts[2];
      if (!id) {
        emitter.error("Usage: /loop stop <id>");
        return;
      }
      deleteLoop(id);
      emitter.text(`✓ Stopped ${id}`);
      emitter.done();
      return;
    }

    if (sub === "list") {
      const loops = listLoops();
      if (loops.length === 0) {
        emitter.text("No active loops.");
      } else {
        const header = "ID                   | Interval | Iterations | Next due            | Prompt";
        const sep = "-".repeat(header.length);
        const rows = loops.map((l) => {
          const next = new Date(l.next_run_at).toISOString().replace("T", " ").slice(0, 19);
          const iters =
            l.max_iterations !== null
              ? `${l.iteration_count}/${l.max_iterations}`
              : `${l.iteration_count}/∞`;
          return `${l.id.padEnd(20)} | ${scheduleLabel(l).padEnd(20)} | ${iters.padEnd(10)} | ${next} | ${l.prompt}`;
        });
        emitter.text([header, sep, ...rows].join("\n"));
      }
      emitter.done();
      return;
    }

    if (sub === "status") {
      const id = parts[2];
      if (!id) {
        emitter.error("Usage: /loop status <id>");
        return;
      }
      const loop = getLoop(id);
      if (!loop) {
        emitter.error(`Loop not found: ${id}`);
        return;
      }
      const next = new Date(loop.next_run_at).toISOString().replace("T", " ").slice(0, 19);
      const iters =
        loop.max_iterations !== null
          ? `${loop.iteration_count}/${loop.max_iterations}`
          : `${loop.iteration_count}/∞`;
      emitter.text(
        [
          `ID:         ${loop.id}`,
          `Session:    ${loop.session_id}`,
          `Prompt:     ${loop.prompt}`,
          `Schedule:   ${scheduleLabel(loop)}`,
          `Iterations: ${iters}`,
          `Next run:   ${next}`,
        ].join("\n")
      );
      emitter.done();
      return;
    }

    // /loop [--max N] <schedule> <prompt...>
    let maxIterations = null;
    const remaining = parts.slice(1);

    const maxIdx = remaining.indexOf("--max");
    if (maxIdx !== -1) {
      const maxVal = parseInt(remaining[maxIdx + 1], 10);
      if (isNaN(maxVal) || maxVal < 1) {
        emitter.error("--max must be a positive integer");
        return;
      }
      maxIterations = maxVal;
      remaining.splice(maxIdx, 2);
    }

    // Cron expressions have spaces, so consume tokens until we hit something
    // that looks like a prompt word (not a cron field). Strategy: try joining
    // increasing prefixes until parseSchedule succeeds.
    let schedule = null;
    let scheduleTokenCount = 0;
    for (let i = 1; i <= Math.min(remaining.length, 5); i++) {
      const attempt = remaining.slice(0, i).join(" ");
      const parsed = parseSchedule(attempt);
      if (parsed) { schedule = parsed; scheduleTokenCount = i; }
    }

    const promptWords = remaining.slice(scheduleTokenCount);

    if (!schedule || promptWords.length === 0) {
      emitter.text(
        [
          "Usage: /loop [--max N] <schedule> <prompt>",
          "",
          "Schedules: 30s, 5m, 1h, daily, weekly",
          "           or a cron expression: \"0 9 * * 1-5\"",
          "Commands:  /loop list | /loop status <id> | /loop stop <id>",
        ].join("\n")
      );
      emitter.done();
      return;
    }

    const prompt = promptWords.join(" ");
    const tz = getSessionTz(ctx.sessionId);
    const tzWarning = schedule.type === "cron" && !tz
      ? "\n⚠ No timezone on session — cron fires in UTC. Pass `timezone` on POST /session to use local time."
      : "";

    let nextRunAt;
    if (schedule.type === "cron") {
      try {
        const job = new Cron(schedule.expr, { timezone: tz || "UTC", paused: true });
        const next = job.nextRun();
        nextRunAt = next ? next.getTime() : Date.now() + 60_000;
      } catch (e) {
        emitter.error(`Invalid cron expression: ${e.message}`);
        return;
      }
    }

    const loop = createLoop({
      sessionId: ctx.sessionId,
      prompt,
      ...(schedule.type === "interval"
        ? { intervalSeconds: schedule.seconds }
        : { cronExpr: schedule.expr, tz: tz || "UTC", nextRunAt }),
      maxIterations,
    });

    const schedDesc = schedule.type === "cron"
      ? `cron "${schedule.expr}"${tz ? " (" + tz + ")" : " (UTC)"}`
      : `every ${remaining[0]}`;
    const maxLabel = maxIterations !== null ? `, max ${maxIterations} iterations` : "";
    emitter.text(`✓ Loop created: ${loop.id} — ${schedDesc}${maxLabel}\nPrompt: ${prompt}${tzWarning}`);
    emitter.done();
  }

  async _tick() {
    const due = dueLoops(Date.now());
    for (const loop of due) {
      if (!this._isSessionActive(loop.session_id)) continue;
      try {
        await this._callPromptAsync(loop.session_id, loop.prompt);
        tickLoop(loop.id, computeNextRunAt(loop));
        const updated = getLoop(loop.id);
        if (
          updated &&
          updated.max_iterations !== null &&
          updated.iteration_count >= updated.max_iterations
        ) {
          deleteLoop(loop.id);
        }
      } catch (e) {
        console.error(`[LoopPlugin] tick error loop=${loop.id}:`, e.message);
      }
    }
  }
}
