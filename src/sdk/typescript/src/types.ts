/**
 * Public option types. `Options` mirrors the Claude Agent SDK's `Options`
 * (camelCase) so existing code is drop-in compatible. The one lite-harness
 * addition is the optional `harness` field; being optional keeps drop-in
 * compatibility intact.
 */

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface Options {
  /** Tool names the agent is allowed to use. */
  allowedTools?: string[];
  /** Tool names the agent is explicitly forbidden from using. */
  disallowedTools?: string[];
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
  /** MCP server configuration, passed opaquely to the server. */
  mcpServers?: Record<string, unknown>;
  /** Initial permission mode for the session. */
  permissionMode?: PermissionMode;
  /** Continue the most recent conversation. */
  continue?: boolean;
  /** Resume a specific session by id. */
  resume?: string;
  /** Maximum number of agent turns before stopping. */
  maxTurns?: number;
  /** Model identifier to use. */
  model?: string;
  /** Fallback model if the primary model is unavailable. */
  fallbackModel?: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Additional directories the agent may access. */
  additionalDirectories?: string[];
  /** Environment variables for the spawned server process. */
  env?: Record<string, string | undefined>;
  /** Extra CLI/server args (value `null` => flag without a value). */
  extraArgs?: Record<string, string | null>;
  /** Receives the server process's stderr output line-by-line. */
  stderr?: (data: string) => void;
  /** Request partial streaming deltas (`stream_event` messages). */
  includePartialMessages?: boolean;
  /** Abort controller to cancel an in-flight run. */
  abortController?: AbortController;

  /** lite-harness extension: select a named harness/agent runtime. */
  harness?: string;
}
