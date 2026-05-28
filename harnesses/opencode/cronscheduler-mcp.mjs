#!/usr/bin/env node
/**
 * Cron Scheduler MCP server — schedule recurring shell commands on the device.
 *
 * Tools:
 *   cron_schedule  — register a new cron job (5-field cron + shell command)
 *   cron_list      — list all jobs (id, schedule, next run, last status)
 *   cron_cancel    — remove a job by id
 *   cron_run_now   — trigger a job immediately outside its schedule
 *   cron_get_logs  — fetch stdout/stderr from a job's recent runs
 *
 * Cron expression format: MIN HOUR DOM MON DOW (standard 5-field)
 * Supported fields: numbers, *, ranges (1-5), steps (*/2), lists (1,3,5)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";

// ── Cron expression parser ────────────────────────────────────────────────────

function parseField(field, min, max) {
  if (field === "*") return null; // null = matches all
  const values = new Set();
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
      const isWildcard = range === "*";
      const [lo, hi] = isWildcard ? [min, max] : range.split("-").map(Number);
      for (let i = isWildcard ? min : lo; i <= (isWildcard ? max : (hi ?? lo)); i += step) {
        values.add(i);
      }
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (isNaN(n)) throw new Error(`Invalid value "${part}"`);
      values.add(n);
    }
  }
  for (const v of values) {
    if (v < min || v > max) throw new Error(`Value ${v} out of range [${min}-${max}]`);
  }
  return values;
}

function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 fields, got ${parts.length}. Format: MIN HOUR DOM MON DOW`);
  const [minF, hourF, domF, monF, dowF] = parts;
  return {
    minute:     parseField(minF,  0, 59),
    hour:       parseField(hourF, 0, 23),
    dayOfMonth: parseField(domF,  1, 31),
    month:      parseField(monF,  1, 12),
    dayOfWeek:  parseField(dowF,  0,  6),
    raw: expr.trim(),
  };
}

function matchesCron(cron, date) {
  return (
    (cron.minute     === null || cron.minute.has(date.getMinutes()))    &&
    (cron.hour       === null || cron.hour.has(date.getHours()))        &&
    (cron.dayOfMonth === null || cron.dayOfMonth.has(date.getDate()))   &&
    (cron.month      === null || cron.month.has(date.getMonth() + 1))   &&
    (cron.dayOfWeek  === null || cron.dayOfWeek.has(date.getDay()))
  );
}

/** Scan minute-by-minute up to 1 year ahead to find the next matching time. */
function nextRunTime(cron) {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let i = 0; i < 525_960; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (matchesCron(cron, candidate)) return candidate;
  }
  return null;
}

// ── Job state ─────────────────────────────────────────────────────────────────

const MAX_LOG_RUNS  = 20;
const MAX_LOG_BYTES = 64 * 1024; // 64 KB captured per run

class Job {
  constructor(id, schedule, command, description) {
    this.id          = id;
    this.schedule    = schedule;   // parsed cron object
    this.command     = command;    // shell command string
    this.description = description || "";
    this.enabled     = true;
    this.running     = false;
    this.runCount    = 0;
    this.lastRunAt   = null;
    this.lastStatus  = null; // null | "ok" | "error:<code>"
    this.logs        = []; // [{ at, exitCode, output }] newest-first
  }

  get nextRun() { return nextRunTime(this.schedule); }
}

const jobs = new Map(); // id → Job
let tickTimer = null;

// ── Job runner ────────────────────────────────────────────────────────────────

async function runJob(job, reason = "scheduled") {
  if (job.running) {
    console.error(`[cron] job ${job.id} still running — skipping (${reason})`);
    return;
  }
  job.running = true;
  job.runCount++;
  const at = new Date();
  console.error(`[cron] starting job "${job.id}" (${reason}) at ${at.toISOString()}`);

  const chunks = [];
  let totalBytes = 0;

  await new Promise((resolve) => {
    const proc = spawn("sh", ["-c", job.command], { env: process.env });

    const capture = (d) => {
      totalBytes += d.length;
      if (totalBytes <= MAX_LOG_BYTES) chunks.push(d);
    };
    proc.stdout.on("data", capture);
    proc.stderr.on("data", capture);

    proc.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8");
      job.lastRunAt  = at;
      job.lastStatus = code === 0 ? "ok" : `error:${code}`;
      job.running    = false;
      job.logs.unshift({ at: at.toISOString(), exitCode: code, output });
      if (job.logs.length > MAX_LOG_RUNS) job.logs.length = MAX_LOG_RUNS;
      console.error(`[cron] job "${job.id}" done exit=${code}`);
      resolve();
    });

    proc.on("error", (err) => {
      job.lastRunAt  = at;
      job.lastStatus = "error:spawn";
      job.running    = false;
      job.logs.unshift({ at: at.toISOString(), exitCode: -1, output: err.message });
      if (job.logs.length > MAX_LOG_RUNS) job.logs.length = MAX_LOG_RUNS;
      resolve();
    });
  });
}

// ── Tick loop — fires every minute, aligned to :00 seconds ───────────────────

function startTick() {
  if (tickTimer) return;

  const tick = () => {
    const now = new Date();
    for (const job of jobs.values()) {
      if (!job.enabled) continue;
      if (matchesCron(job.schedule, now)) {
        runJob(job, "scheduled").catch((e) =>
          console.error(`[cron] tick error for job "${job.id}": ${e.message}`),
        );
      }
    }
    const msUntilNext = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    tickTimer = setTimeout(tick, msUntilNext);
  };

  const now = new Date();
  const msUntilNext = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  tickTimer = setTimeout(tick, msUntilNext);
  console.error(`[cron-scheduler] tick loop started; first tick in ${Math.round(msUntilNext / 1000)}s`);
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "cron-scheduler", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "cron_schedule",
    description:
      "Schedule a recurring task on the device using a standard 5-field cron expression. " +
      "The command is executed via `sh -c` on the host. Returns the assigned job ID. " +
      "Cron format: MIN HOUR DOM MON DOW. " +
      "Examples: '*/5 * * * *' = every 5 min, '0 9 * * 1-5' = 09:00 Mon-Fri. " +
      "Supported: numbers, * (any), ranges (1-5), steps (*/2), comma lists (1,3,5).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Unique job ID (letters, digits, hyphens, underscores). " +
            "Auto-generated if omitted.",
        },
        schedule: {
          type: "string",
          description:
            "5-field cron expression. E.g. '0 * * * *' runs every hour on the hour.",
        },
        command: {
          type: "string",
          description:
            "Shell command to run. E.g. 'curl -s https://example.com >> /tmp/out.log'.",
        },
        description: {
          type: "string",
          description: "Optional human-readable description of what this job does.",
        },
      },
      required: ["schedule", "command"],
    },
  },
  {
    name: "cron_list",
    description:
      "List all scheduled cron jobs with their ID, cron expression, command, " +
      "next scheduled run time, run count, and last exit status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cron_cancel",
    description: "Cancel and permanently remove a scheduled cron job by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the job to cancel." },
      },
      required: ["id"],
    },
  },
  {
    name: "cron_run_now",
    description:
      "Trigger a scheduled cron job immediately, outside its regular schedule. " +
      "Waits for the job to finish and returns its output.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the job to run immediately." },
      },
      required: ["id"],
    },
  },
  {
    name: "cron_get_logs",
    description: "Fetch stdout + stderr output from a job's most recent runs.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job ID." },
        limit: {
          type: "number",
          description: "Number of past runs to return (default 5, max 20).",
        },
      },
      required: ["id"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function autoId() {
  return `job-${Date.now().toString(36)}`;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // ── cron_schedule ───────────────────────────────────────────────────────────
  if (name === "cron_schedule") {
    const { schedule, command, description } = args;
    let { id } = args;
    if (!schedule) return textResult("'schedule' is required (5-field cron expression)", true);
    if (!command)  return textResult("'command' is required (shell command to run)", true);
    if (!id) id = autoId();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id))
      return textResult(`Invalid id "${id}". Use letters, digits, hyphens, underscores only.`, true);
    if (jobs.has(id))
      return textResult(`Job "${id}" already exists. Cancel it first or choose a different id.`, true);
    let parsed;
    try { parsed = parseCron(schedule); }
    catch (e) { return textResult(`Invalid cron expression: ${e.message}`, true); }
    const job = new Job(id, parsed, command, description);
    jobs.set(id, job);
    startTick();
    const next = job.nextRun;
    return textResult(
      `Scheduled job "${id}"\n` +
      `  Schedule:    ${schedule}\n` +
      `  Command:     ${command}\n` +
      (description ? `  Description: ${description}\n` : "") +
      `  Next run:    ${next ? next.toISOString() : "never (no match found in the next year)"}`,
    );
  }

  // ── cron_list ───────────────────────────────────────────────────────────────
  if (name === "cron_list") {
    if (jobs.size === 0) return textResult("No cron jobs scheduled.");
    const lines = [];
    for (const job of jobs.values()) {
      const next = job.nextRun;
      lines.push(
        `• ${job.id}  [${job.enabled ? "enabled" : "disabled"}${job.running ? ", running" : ""}]\n` +
        `  Schedule: ${job.schedule.raw}\n` +
        `  Command:  ${job.command}\n` +
        (job.description ? `  Desc:     ${job.description}\n` : "") +
        `  Runs:     ${job.runCount}   Last status: ${job.lastStatus ?? "never run"}\n` +
        `  Last run: ${job.lastRunAt ? job.lastRunAt.toISOString() : "—"}\n` +
        `  Next run: ${next ? next.toISOString() : "—"}`,
      );
    }
    return textResult(lines.join("\n\n"));
  }

  // ── cron_cancel ─────────────────────────────────────────────────────────────
  if (name === "cron_cancel") {
    const { id } = args;
    if (!id) return textResult("'id' is required", true);
    if (!jobs.has(id)) return textResult(`No job with id "${id}".`, true);
    jobs.delete(id);
    return textResult(`Cancelled and removed job "${id}".`);
  }

  // ── cron_run_now ────────────────────────────────────────────────────────────
  if (name === "cron_run_now") {
    const { id } = args;
    if (!id) return textResult("'id' is required", true);
    const job = jobs.get(id);
    if (!job) return textResult(`No job with id "${id}".`, true);
    await runJob(job, "manual");
    const latest = job.logs[0];
    return textResult(
      `Job "${id}" completed (exit ${latest?.exitCode ?? "?"})`  +
      `\nOutput:\n${latest?.output || "(no output)"}`,
      (latest?.exitCode ?? 0) !== 0,
    );
  }

  // ── cron_get_logs ───────────────────────────────────────────────────────────
  if (name === "cron_get_logs") {
    const { id } = args;
    const limit = Math.min(Math.max(parseInt(String(args.limit ?? "5"), 10), 1), MAX_LOG_RUNS);
    if (!id) return textResult("'id' is required", true);
    const job = jobs.get(id);
    if (!job) return textResult(`No job with id "${id}".`, true);
    if (job.logs.length === 0) return textResult(`Job "${id}" has not run yet.`);
    const entries = job.logs.slice(0, limit);
    const lines = entries.map((e, i) =>
      `--- Run ${i + 1} at ${e.at}  (exit ${e.exitCode}) ---\n${e.output || "(no output)"}`,
    );
    return textResult(lines.join("\n\n"));
  }

  return textResult(`Unknown tool: ${name}`, true);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (tickTimer) clearTimeout(tickTimer);
    process.exit(0);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
startTick();
console.error("[cron-scheduler] ready");
