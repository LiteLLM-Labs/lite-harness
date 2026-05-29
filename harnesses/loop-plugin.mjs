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

function parseInterval(raw) {
  if (raw === "daily") return 86400;
  if (raw === "weekly") return 604800;
  const m = /^(\d+)(s|m|h)$/.exec(raw);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (m[2] === "s") return n;
  if (m[2] === "m") return n * 60;
  if (m[2] === "h") return n * 3600;
  return null;
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
          return `${l.id.padEnd(20)} | ${String(l.interval_seconds + "s").padEnd(8)} | ${iters.padEnd(10)} | ${next} | ${l.prompt}`;
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
          `Interval:   ${loop.interval_seconds}s`,
          `Iterations: ${iters}`,
          `Next run:   ${next}`,
        ].join("\n")
      );
      emitter.done();
      return;
    }

    // /loop [--max N] <interval> <prompt...>
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

    const intervalRaw = remaining[0];
    const promptWords = remaining.slice(1);

    if (!intervalRaw || promptWords.length === 0) {
      emitter.text(
        [
          "Usage: /loop [--max N] <interval> <prompt>",
          "",
          "Intervals: 30s, 5m, 1h, daily, weekly",
          "Commands:  /loop list | /loop status <id> | /loop stop <id>",
        ].join("\n")
      );
      emitter.done();
      return;
    }

    const intervalSeconds = parseInterval(intervalRaw);
    if (intervalSeconds === null) {
      emitter.error(`Unknown interval: ${intervalRaw}`);
      return;
    }

    const prompt = promptWords.join(" ");
    const loop = createLoop({
      sessionId: ctx.sessionId,
      prompt,
      intervalSeconds,
      maxIterations,
    });

    const maxLabel = maxIterations !== null ? `, max ${maxIterations} iterations` : "";
    emitter.text(`✓ Loop created: ${loop.id} — every ${intervalRaw}${maxLabel}\nPrompt: ${prompt}`);
    emitter.done();
  }

  async _tick() {
    const due = dueLoops(Date.now());
    for (const loop of due) {
      if (!this._isSessionActive(loop.session_id)) continue;
      try {
        await this._callPromptAsync(loop.session_id, loop.prompt);
        tickLoop(loop.id, Date.now());
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
