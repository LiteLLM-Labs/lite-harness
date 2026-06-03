/**
 * Compile-time superset assertion. TYPE-ONLY: this file is type-checked by
 * `npm run typecheck` but never compiled to `dist` and never executed.
 *
 * It constructs a single `AgentOptions` literal that uses EVERY field name in
 * our public `AgentOptions` type with a valid sample value. If a field is removed or
 * renamed, this literal stops type-checking and the build breaks — which is
 * exactly the parity guard we want.
 *
 * It deliberately does NOT import `@anthropic-ai/claude-agent-sdk`: that
 * package may be absent in CI, and a type-only `import type` of an absent
 * package would fail. Runtime export parity against the real upstream package
 * (when installed) is covered separately by `parity.test.mjs`.
 */

import type { AgentOptions, Options } from "../types.js";

const _full: AgentOptions = {
  abortController: new AbortController(),
  additionalDirectories: [],
  harness: "openai",
  agent: "codex",
  agentProgressSummaries: true,
  agents: {},
  allowDangerouslySkipPermissions: false,
  allowedTools: [],
  betas: [],
  canUseTool: async () => undefined,
  continue: true,
  cwd: "/tmp",
  debug: false,
  debugFile: "/tmp/debug.log",
  disallowedTools: [],
  effort: "medium",
  enableFileCheckpointing: false,
  env: { PATH: process.env.PATH },
  executable: "node",
  executableArgs: ["--no-warnings"],
  extraArgs: { flag: null, valued: "x" },
  fallbackModel: "claude-haiku",
  forkSession: false,
  forwardSubagentText: true,
  hooks: {},
  includeHookEvents: false,
  includePartialMessages: false,
  loadTimeoutMs: 30000,
  managedSettings: { enforced: true },
  maxBudgetUsd: 1.5,
  maxThinkingTokens: 1024,
  maxTurns: 10,
  mcpServers: {},
  model: "claude-opus",
  onElicitation: async () => undefined,
  outputFormat: "json",
  pathToClaudeCodeExecutable: "/usr/local/bin/claude",
  permissionMode: "default",
  permissionPromptToolName: "AskUser",
  persistSession: true,
  planModeInstructions: "be careful",
  plugins: [],
  promptSuggestions: ["try this"],
  resume: "session-123",
  resumeSessionAt: "msg-456",
  sandbox: { kind: "none" },
  sessionId: "sess-789",
  sessionStore: { custom: true },
  sessionStoreFlush: "batched",
  settings: { theme: "dark" },
  settingSources: ["user", "project"],
  skills: "all",
  spawnClaudeCodeProcess: () => undefined,
  stderr: (_data: string) => undefined,
  strictMcpConfig: true,
  systemPrompt: { type: "preset", preset: "default", append: "extra" },
  taskBudget: { tokens: 1000 },
  thinking: { type: "enabled" },
  title: "My session",
  toolAliases: { Read: "ReadFile" },
  toolConfig: { Read: { enabled: true } },
  tools: { type: "preset", preset: "all" },
};

void _full;

const _compat: Options = _full;
void _compat;
