/**
 * Exception hierarchy mirroring the Claude Agent SDK.
 *
 * `ClaudeSDKError` is the base; everything else derives from it so callers can
 * catch the whole family with a single `instanceof ClaudeSDKError` check.
 */

/** Base class for all SDK errors. */
export class ClaudeSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSDKError";
  }
}

/** Raised when an in-flight run is aborted via an `AbortController`. */
export class AbortError extends Error {
  constructor(message = "Request was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** The lite-harness server binary/command could not be found. */
export class CLINotFoundError extends ClaudeSDKError {
  constructor(message: string) {
    super(message);
    this.name = "CLINotFoundError";
  }
}

/** Spawning or connecting to the server failed. */
export class CLIConnectionError extends ClaudeSDKError {
  constructor(message: string) {
    super(message);
    this.name = "CLIConnectionError";
  }
}

/** The server process exited abnormally. */
export class ProcessError extends ClaudeSDKError {
  readonly exitCode: number | null;
  readonly stderr: string | null;

  constructor(
    message: string,
    options: { exitCode?: number | null; stderr?: string | null } = {},
  ) {
    const exitCode = options.exitCode ?? null;
    const stderr = options.stderr ?? null;
    let full = message;
    if (exitCode !== null) {
      full = `${full} (exit code: ${exitCode})`;
    }
    if (stderr) {
      full = `${full}\n${stderr}`;
    }
    super(full);
    this.name = "ProcessError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** A line received from the server was not valid JSON. */
export class CLIJSONDecodeError extends ClaudeSDKError {
  readonly line: string;
  readonly originalError: unknown;

  constructor(line: string, originalError: unknown) {
    super(`Failed to decode JSON line: ${JSON.stringify(line)}\n${String(originalError)}`);
    this.name = "CLIJSONDecodeError";
    this.line = line;
    this.originalError = originalError;
  }
}
