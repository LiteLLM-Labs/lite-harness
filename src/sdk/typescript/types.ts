/**
 * Public option types. `AgentOptions` is the lite-harness options type.
 * It accepts the Claude Agent SDK's `Options` fields for migration
 * compatibility, plus `harness` for selecting the agent harness.
 *
 * `AgentOptions` is a TRUE SUPERSET of the upstream `@anthropic-ai/claude-agent-sdk`
 * `Options` type: every field the upstream SDK accepts is accepted here. Fields
 * that lite-harness honors directly (e.g. `harness`, `model`, `permissionMode`,
 * `cwd`, `env`) are mapped to launch flags in `buildLaunchArgs`. The remaining
 * advanced/complex fields are accepted purely for drop-in compatibility: they
 * type-check and are forwarded opaquely (or simply ignored) but are NOT yet
 * honored by the lite-harness runtime. Opaque/complex shapes are typed as
 * `unknown` (never `any`) so callers retain type-safety at the boundary.
 */

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface AgentOptions {
  /** Tool names the agent is allowed to use. */
  allowedTools?: string[];
  /** Tool names the agent is explicitly forbidden from using. */
  disallowedTools?: string[];
  /**
   * System prompt prepended to the conversation. May be a plain string or a
   * preset reference with an optional append.
   */
  systemPrompt?: string | { type: "preset"; preset: string; append?: string };
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

  /** Select the agent harness (e.g. "claude", "openai"). */
  harness?: string;
  /** Backward-compatible alias. `harness` wins when both are provided. */
  agent?: string;

  // --- Upstream parity fields ---------------------------------------------
  // The fields below complete the superset of the upstream Claude Agent SDK
  // `AgentOptions`. They are accepted for drop-in compatibility and forwarded
  // opaquely / not yet honored by the lite-harness runtime unless noted above.

  /**
   * Named agent definitions keyed by name. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  agents?: Record<string, unknown>;
  /**
   * Anthropic beta feature flags. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  betas?: string[];
  /**
   * Programmatic tool-permission callback. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  canUseTool?: (...args: unknown[]) => Promise<unknown>;
  /**
   * Emit verbose debug output. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  debug?: boolean;
  /**
   * Reasoning effort level. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Enable file checkpointing. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  enableFileCheckpointing?: boolean;
  /**
   * Fork the resumed session instead of continuing it in place. Accepted for
   * drop-in compat and forwarded opaquely / not yet honored.
   */
  forkSession?: boolean;
  /**
   * Lifecycle hook definitions keyed by event name. Complex/opaque shape;
   * accepted for drop-in compat and forwarded opaquely / not yet honored.
   */
  hooks?: Record<string, unknown>;
  /**
   * Include hook-event messages in the stream. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  includeHookEvents?: boolean;
  /**
   * Hard USD budget cap for the run. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  maxBudgetUsd?: number;
  /**
   * Maximum thinking-token budget. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  maxThinkingTokens?: number;
  /**
   * Provider/output format selector. Opaque shape; accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  outputFormat?: unknown;
  /**
   * Tool name used to prompt for permission. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  permissionPromptToolName?: string;
  /**
   * Persist the session to the session store. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  persistSession?: boolean;
  /**
   * Extra instructions injected in plan mode. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  planModeInstructions?: string;
  /**
   * Plugin definitions. Complex/opaque shape; accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  plugins?: unknown[];
  /**
   * Resume the session at a specific message id / checkpoint. Accepted for
   * drop-in compat and forwarded opaquely / not yet honored.
   */
  resumeSessionAt?: string;
  /**
   * Sandbox configuration. Complex/opaque shape; accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  sandbox?: unknown;
  /**
   * Explicit session id to use. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  sessionId?: string;
  /**
   * Session store implementation. Complex/opaque shape; accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  sessionStore?: unknown;
  /**
   * Session-store flush strategy. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  sessionStoreFlush?: "batched" | "eager";
  /**
   * Settings path or inline settings object. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  settings?: string | Record<string, unknown>;
  /**
   * Sources to load settings from. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  settingSources?: string[];
  /**
   * Skills to enable (named list, or `"all"`). Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  skills?: string[] | "all";
  /**
   * Restrict MCP config to the provided servers only. Accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  strictMcpConfig?: boolean;
  /**
   * Thinking configuration. Complex/opaque shape; accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  thinking?: unknown;
  /**
   * Tool set (named list, or a preset reference). Accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  tools?: string[] | { type: "preset"; preset: string };

  /**
   * Emit per-subagent progress summaries. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  agentProgressSummaries?: unknown;
  /**
   * Skip permission prompts (dangerous). Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  allowDangerouslySkipPermissions?: boolean;
  /**
   * Path to a debug-log file. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  debugFile?: string;
  /**
   * Executable used to launch the runtime (e.g. "node"). Accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  executable?: string;
  /**
   * Extra args for {@link executable}. Accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  executableArgs?: string[];
  /**
   * Forward subagent text output to the parent stream. Accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  forwardSubagentText?: unknown;
  /**
   * Timeout (ms) for the server to finish loading. Accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  loadTimeoutMs?: number;
  /**
   * Managed (enterprise) settings. Complex/opaque shape; accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  managedSettings?: unknown;
  /**
   * Elicitation callback (interactive prompts from the server). Accepted for
   * drop-in compat and forwarded opaquely / not yet honored.
   */
  onElicitation?: (...args: unknown[]) => unknown;
  /**
   * Explicit path to the Claude Code executable. Accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  pathToClaudeCodeExecutable?: string;
  /**
   * Prompt-suggestion configuration. Complex/opaque shape; accepted for drop-in
   * compat and forwarded opaquely / not yet honored.
   */
  promptSuggestions?: unknown;
  /**
   * Custom process spawner for the Claude Code runtime. Complex/opaque shape;
   * accepted for drop-in compat and forwarded opaquely / not yet honored.
   */
  spawnClaudeCodeProcess?: unknown;
  /**
   * Per-run task budget. Complex/opaque shape; accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  taskBudget?: unknown;
  /**
   * Human-readable session title. Accepted for drop-in compat and forwarded
   * opaquely / not yet honored.
   */
  title?: string;
  /**
   * Tool name aliases. Complex/opaque shape; accepted for drop-in compat and
   * forwarded opaquely / not yet honored.
   */
  toolAliases?: unknown;
  /**
   * Per-tool configuration. Complex/opaque shape; accepted for drop-in compat
   * and forwarded opaquely / not yet honored.
   */
  toolConfig?: unknown;
}

// ---------------------------------------------------------------------------
// Compatibility stand-in types
// ---------------------------------------------------------------------------
// These are PERMISSIVE stand-ins, NOT full upstream models. They exist so
// drop-in consumers can `import type { CanUseTool } from "@lite-harness/sdk"`
// and have it resolve. Objects are `Record<string, unknown>` / `unknown` and
// callbacks are loose `(...args: unknown[]) => …`. lite-harness does not yet
// honor these behaviors; the types only preserve import compatibility.

/** Permission decision returned by a {@link CanUseTool} callback. */
export type PermissionResult = Record<string, unknown>;

/** A single permission-update directive. */
export type PermissionUpdate = Record<string, unknown>;

/** Programmatic tool-permission callback. */
export type CanUseTool = (...args: unknown[]) => Promise<PermissionResult> | PermissionResult;

/** Lifecycle hook event name. */
export type HookEvent = string;

/** A lifecycle hook callback. */
export type HookCallback = (...args: unknown[]) => Promise<unknown> | unknown;

/** MCP server configuration entry. */
export type McpServerConfig = Record<string, unknown>;

/** A named agent definition. */
export type AgentDefinition = Record<string, unknown>;

/** A source from which settings may be loaded (e.g. "user", "project"). */
export type SettingSource = string;

/** Compatibility alias for older examples and Claude Agent SDK migration code. */
export type Options = AgentOptions;
