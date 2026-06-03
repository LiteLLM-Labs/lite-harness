/**
 * `query()` — the single public entry point. Mirrors the Claude Agent SDK's JS
 * shape exactly: there is NO client class. `query()` returns a {@link Query}
 * which extends `AsyncGenerator<SDKMessage, void>` and additionally carries
 * control methods.
 *
 * Lifecycle (per PROTOCOL.md): on first iteration the generator lazily spawns
 * the server, sends the `initialize` control_request, writes the `user` line to
 * start the turn, then yields decoded messages until (and including) the
 * `result` message, then completes. Early `return()`/break/`close()`/abort
 * tears down the process. Control methods send control_requests and await their
 * control_response.
 */

import { decodeMessage } from "./decode.js";
import { AbortError } from "./errors.js";
import type { SDKMessage, SDKUserMessage } from "./messages.js";
import { Transport } from "./transport.js";
import type { AgentOptions, PermissionMode } from "./types.js";

/**
 * The object returned by {@link query}. It IS the async generator (you iterate
 * it with `for await`) and also exposes control methods to steer the live run.
 */
export interface Query extends AsyncGenerator<SDKMessage, void, void> {
  /** Interrupt the in-flight run. */
  interrupt(): Promise<void>;
  /** Change the permission mode for the live session. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Change the model for the live session (omit to reset to default). */
  setModel(model?: string): Promise<void>;
  /** Tear down the session and kill the server process. */
  close(): void;
}

/**
 * Build the stream-json launch flags from options, mirroring the claude CLI:
 *   --input-format stream-json --output-format stream-json --verbose
 *   [--agent <a>] [--model <m>] [--permission-mode <p>] [--cwd <dir>]
 */
function buildLaunchArgs(options: AgentOptions): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  const harness = options.harness ?? options.agent;
  if (harness !== undefined) {
    args.push("--agent", harness);
  }
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  if (options.permissionMode !== undefined) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.cwd !== undefined) {
    args.push("--cwd", options.cwd);
  }
  return args;
}

/** Internal hidden symbol-free flag bag for a single run. */
class QueryRunner {
  private readonly transport: Transport;
  private started = false;
  private finished = false;
  private readonly promptText: string;

  constructor(
    prompt: string | AsyncIterable<SDKUserMessage>,
    private readonly options: AgentOptions,
  ) {
    this.promptText = typeof prompt === "string" ? prompt : "";
    this.transport = new Transport({
      cwd: options.cwd,
      // Pass the caller env through; the transport merges it onto process.env
      // so a partial `env` never drops PATH and friends.
      env: options.env,
      stderr: options.stderr,
      abortController: options.abortController,
      args: buildLaunchArgs(options),
    });
  }

  private get aborted(): boolean {
    return this.options.abortController?.signal.aborted ?? false;
  }

  private throwIfAborted(): void {
    if (this.aborted) {
      throw new AbortError();
    }
  }

  /** Spawn, send the `initialize` control_request, then write the user line. */
  private async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.throwIfAborted();
    this.transport.connect();

    await this.transport.sendControl("initialize", { hooks: {}, sdk_mcp_servers: [] });
    this.throwIfAborted();

    await this.transport.sendUserMessage(this.promptText);
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.finished) {
      return { value: undefined, done: true };
    }
    try {
      await this.start();
    } catch (err) {
      await this.teardown(false);
      throw err;
    }

    while (true) {
      if (this.aborted) {
        await this.teardown(false);
        throw new AbortError();
      }
      const result = await this.transport.nextLine();
      if (result.done) {
        // Stream ended without an explicit result; close out cleanly.
        await this.teardown(false);
        return { value: undefined, done: true };
      }
      const message = decodeMessage(result.value);
      if (message.type === "result") {
        // NORMAL completion: end stdin and let the server exit on its own
        // (PROTOCOL.md) before falling back to a hard kill.
        this.finished = true;
        await this.teardown(true);
        return { value: message, done: false };
      }
      return { value: message, done: false };
    }
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    // Early return()/break is not a normal completion — tear down immediately.
    await this.teardown(false);
    return { value: undefined, done: true };
  }

  async throw(err?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    await this.teardown(false);
    throw err instanceof Error ? err : new Error(String(err));
  }

  private tearingDown: Promise<void> | null = null;

  /**
   * Tear down the transport. `graceful` true (a `result` was delivered) ends
   * stdin and waits a short grace period for the server to exit on its own;
   * false (abort / early return / error) kills immediately.
   */
  private async teardown(graceful: boolean): Promise<void> {
    if (this.tearingDown) {
      return this.tearingDown;
    }
    this.tearingDown = (async () => {
      this.finished = true;
      this.transport.markClosed();
      if (graceful) {
        await this.transport.shutdownGraceful();
      } else {
        this.transport.kill();
      }
    })();
    return this.tearingDown;
  }

  // --- control methods ---

  async interrupt(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.transport.sendControl("interrupt");
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.transport.sendControl("set_permission_mode", { permission_mode: mode });
  }

  async setModel(model?: string): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.transport.sendControl("set_model", { model: model ?? null });
  }

  close(): void {
    this.transport.markClosed();
    this.transport.kill();
    this.finished = true;
  }
}

/**
 * Run a single agent prompt against a lite-harness server. Returns a
 * {@link Query} that you iterate with `for await` and can steer via its control
 * methods.
 */
export function query({
  prompt,
  options = {},
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: AgentOptions;
}): Query {
  const runner = new QueryRunner(prompt, options);

  const q: Query = {
    next: () => runner.next(),
    return: () => runner.return(),
    throw: (err?: unknown) => runner.throw(err),
    [Symbol.asyncIterator](): Query {
      return q;
    },
    interrupt: () => runner.interrupt(),
    setPermissionMode: (mode: PermissionMode) => runner.setPermissionMode(mode),
    setModel: (model?: string) => runner.setModel(model),
    close: () => runner.close(),
  };
  return q;
}
