/**
 * Transport: the single place that owns process spawn, NDJSON framing over
 * stdio, the multiplexed Claude Agent SDK stream-json control protocol, and
 * routing of incoming lines into either a control-request correlation map
 * (keyed by `request_id`) or an internal pushable queue of decoded messages.
 *
 * See PROTOCOL.md. No agent/business logic lives here.
 *
 * One NDJSON stream carries everything. We demux every incoming line on its
 * top-level `type`:
 *   - `control_response`  -> resolve/reject the pending control request keyed
 *                            by `response.request_id`.
 *   - everything else     -> push the raw object into the message queue, where
 *                            `query.ts` decodes it into an `SDKMessage`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomBytes } from "node:crypto";

import {
  AbortError,
  CLIConnectionError,
  CLINotFoundError,
  ProcessError,
} from "./errors.js";

/** Grace period (ms) to let the server exit on its own after stdin is ended. */
const GRACEFUL_EXIT_MS = 2000;

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** A single buffered incoming (non-control) wire object. */
export type IncomingLine = unknown;

/** How the transport should locate and launch the server process. */
export interface TransportConfig {
  /** Explicit command override (tests inject a fake server here). Highest priority. */
  command?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Environment variables for the spawned process. */
  env?: Record<string, string | undefined>;
  /** Receives server stderr line-by-line. */
  stderr?: (data: string) => void;
  /** Aborts the connection / kills the process. */
  abortController?: AbortController;
  /** Extra args appended to the spawn command (the stream-json flags etc.). */
  args?: string[];
}

/**
 * Resolve the server spawn command per PROTOCOL.md "Server command resolution":
 *   1. explicit transport argument,
 *   2. `LITE_HARNESS_SERVER` env var (a command line), else
 *   3. the bundled default.
 */
export function resolveServerCommand(
  explicit: string[] | undefined,
  env: Record<string, string | undefined>,
): string[] {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = env.LITE_HARNESS_SERVER;
  if (fromEnv && fromEnv.trim().length > 0) {
    // A simple whitespace split is sufficient for the documented "command line".
    return fromEnv.trim().split(/\s+/);
  }
  // Bundled default. There is no packaged server in this scaffold, so we point
  // at a conventional location; callers without one should set the env var or
  // pass an explicit command.
  return ["node", "lite-harness-server"];
}

/**
 * Owns the child process and the NDJSON wire. Construct, then `sendControl()`
 * for control_request/control_response round-trips, `sendUserMessage()` to
 * start a turn, and pull buffered incoming lines with `nextLine()`.
 */
export class Transport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private stderrRl: Interface | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();

  // Incoming-line pushable: a queue plus a single waiter.
  private readonly lineQueue: IncomingLine[] = [];
  private lineWaiter: ((value: IteratorResult<IncomingLine>) => void) | null = null;
  private linesDone = false;

  private closed = false;
  private connectError: Error | null = null;
  private stderrBuffer = "";

  constructor(private readonly config: TransportConfig) {}

  /** Spawn the server process and begin reading its stdout. */
  connect(): void {
    if (this.child) {
      return;
    }
    // Merge the caller-supplied env ON TOP of the current process env so a
    // partial `env` option never drops PATH and friends. Server command
    // resolution sees the merged view too (so a caller can set
    // LITE_HARNESS_SERVER without restating the whole environment).
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.config.env,
    };
    const command = resolveServerCommand(this.config.command, env);
    const [bin, ...baseArgs] = command;
    if (!bin) {
      throw new CLINotFoundError("No server command could be resolved.");
    }
    const args = [...baseArgs, ...(this.config.args ?? [])];

    // Filter undefined env values for spawn's stricter typing.
    const spawnEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        spawnEnv[key] = value;
      }
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, {
        cwd: this.config.cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new CLIConnectionError(`Failed to spawn server "${bin}": ${String(err)}`);
    }
    this.child = child;

    child.on("error", (err: NodeJS.ErrnoException) => {
      const error =
        err.code === "ENOENT"
          ? new CLINotFoundError(`Server command not found: "${bin}"`)
          : new CLIConnectionError(`Server process error: ${err.message}`);
      this.failAll(error);
    });

    child.on("exit", (code) => {
      if (this.closed) {
        this.finishLines();
        return;
      }
      // Unexpected exit while requests are outstanding.
      const error = new ProcessError("Server process exited", {
        exitCode: code,
        stderr: this.stderrBuffer || null,
      });
      this.failAll(error);
    });

    this.stderrRl = createInterface({ input: child.stderr });
    this.stderrRl.on("line", (line) => {
      this.stderrBuffer += line + "\n";
      this.config.stderr?.(line);
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    const abort = this.config.abortController;
    if (abort) {
      if (abort.signal.aborted) {
        this.kill();
      } else {
        abort.signal.addEventListener("abort", () => this.kill(), { once: true });
      }
    }
  }

  /**
   * Reject every still-pending control-request promise so a bare
   * `await q.interrupt()` racing teardown never hangs forever. Used on abort /
   * kill. Defaults to {@link AbortError}.
   */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Forward-compat (PROTOCOL.md): a single unparseable stdout line must NOT
      // tear down the session. Skip it — optionally surfacing it as a stderr
      // diagnostic — and keep reading. A newer server emitting a line shape an
      // older SDK can't parse should never kill an in-flight turn.
      this.config.stderr?.(`[lite-harness] skipped unparseable stdout line: ${trimmed}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const obj = parsed as Record<string, unknown>;

    // Control response: route to the matching pending control request.
    if (obj.type === "control_response") {
      this.handleControlResponse(obj);
      return;
    }

    // Everything else is a turn message — push it to the queue for decoding.
    this.pushLine(obj);
  }

  private handleControlResponse(obj: Record<string, unknown>): void {
    const response =
      typeof obj.response === "object" && obj.response !== null
        ? (obj.response as Record<string, unknown>)
        : {};
    const requestId = typeof response.request_id === "string" ? response.request_id : null;
    if (requestId === null) {
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    if (response.subtype === "error") {
      const message =
        typeof response.error === "string" ? response.error : "control request failed";
      pending.reject(new CLIConnectionError(`Server control error: ${message}`));
    } else {
      pending.resolve(response);
    }
  }

  private newRequestId(): string {
    const suffix = randomBytes(3).toString("hex");
    return `req_${++this.requestCounter}_${suffix}`;
  }

  /**
   * Send a `control_request` with the given subtype + extra fields and await the
   * matching `control_response`. Rejects if the server replies with an error
   * subtype.
   */
  sendControl(
    subtype: string,
    fields: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (this.connectError) {
      return Promise.reject(this.connectError);
    }
    if (!this.child || this.closed) {
      return Promise.reject(new CLIConnectionError("Transport is not connected."));
    }
    const requestId = this.newRequestId();
    const payload =
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype, ...fields },
      }) + "\n";
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.write(payload, (err) => {
        if (err) {
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  /**
   * Start a turn by writing a `user` line. There is no request/response — the
   * server simply streams system/assistant/result lines until the turn ends.
   */
  sendUserMessage(content: string | unknown[]): Promise<void> {
    if (this.connectError) {
      return Promise.reject(this.connectError);
    }
    if (!this.child || this.closed) {
      return Promise.reject(new CLIConnectionError("Transport is not connected."));
    }
    const payload =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
        session_id: null,
        parent_tool_use_id: null,
      }) + "\n";
    return new Promise<void>((resolve, reject) => {
      this.write(payload, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private write(payload: string, done: (err?: Error) => void): void {
    try {
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          done(new CLIConnectionError(`Failed to write to server: ${err.message}`));
        } else {
          done();
        }
      });
    } catch (err) {
      done(new CLIConnectionError(`Failed to write to server: ${String(err)}`));
    }
  }

  /** Pull the next buffered incoming line, awaiting one if the queue is empty. */
  nextLine(): Promise<IteratorResult<IncomingLine>> {
    if (this.lineQueue.length > 0) {
      const value = this.lineQueue.shift() as IncomingLine;
      return Promise.resolve({ value, done: false });
    }
    if (this.linesDone) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.lineWaiter = resolve;
    });
  }

  private pushLine(line: IncomingLine): void {
    if (this.lineWaiter) {
      const waiter = this.lineWaiter;
      this.lineWaiter = null;
      waiter({ value: line, done: false });
    } else {
      this.lineQueue.push(line);
    }
  }

  private finishLines(): void {
    this.linesDone = true;
    if (this.lineWaiter) {
      const waiter = this.lineWaiter;
      this.lineWaiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  private failAll(error: Error): void {
    this.connectError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.finishLines();
  }

  /**
   * Immediately terminate the child process and stop reading. Reserved for
   * abort / early `return()` / error paths — see {@link shutdownGraceful} for
   * normal completion. Rejects any still-pending control promises so callers
   * racing teardown never hang.
   */
  kill(): void {
    this.closed = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.rl?.close();
    this.rl = null;
    this.stderrRl?.close();
    this.stderrRl = null;
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        // ignore
      }
      this.child.kill();
      this.child = null;
    }
    this.rejectPending(new AbortError("Transport closed before control response."));
    this.finishLines();
  }

  /**
   * Graceful shutdown for NORMAL completion (PROTOCOL.md: a one-shot turn ends
   * stdin and lets the server exit on its own). End stdin, wait a short grace
   * period for the process to exit, then fall back to {@link kill} if it has
   * not. Resolves once the process is gone (or killed).
   */
  shutdownGraceful(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.kill();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finalize = (): void => {
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        // kill() is idempotent and closes readers + rejects any leftover
        // pending promises; safe to call even after a clean exit.
        this.kill();
        resolve();
      };
      child.once("exit", finalize);
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      this.graceTimer = setTimeout(finalize, GRACEFUL_EXIT_MS);
      // Don't keep the event loop alive purely for the grace timer.
      this.graceTimer.unref?.();
    });
  }

  /** Mark closed (after a graceful shutdown) so an exit is not treated as an error. */
  markClosed(): void {
    this.closed = true;
  }
}
