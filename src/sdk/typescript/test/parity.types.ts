/**
 * Compile-time superset assertion. TYPE-ONLY: this file is type-checked by
 * `npm run typecheck` but never compiled to `dist` and never executed.
 *
 * It constructs a single `Options` literal that uses EVERY field name in our
 * public `Options` type with a valid sample value. If a field is removed or
 * renamed, this literal stops type-checking and the build breaks — which is
 * exactly the parity guard we want.
 *
 * It deliberately does NOT import `@anthropic-ai/claude-agent-sdk`: that
 * package may be absent in CI, and a type-only `import type` of an absent
 * package would fail. Runtime export parity against the real upstream package
 * (when installed) is covered separately by `parity.test.mjs`.
 */

import type { Options } from "../types.js";

const _full: Options = {
  abortController: new AbortController(),
  additionalDirectories: [],
  agent: "codex",
  agents: {},
  allowedTools: [],
  betas: [],
  canUseTool: async () => undefined,
  continue: true,
  cwd: "/tmp",
  debug: false,
  disallowedTools: [],
  effort: "medium",
  enableFileCheckpointing: false,
  env: { PATH: process.env.PATH },
  extraArgs: { flag: null, valued: "x" },
  fallbackModel: "claude-haiku",
  forkSession: false,
  hooks: {},
  includeHookEvents: false,
  includePartialMessages: false,
  maxBudgetUsd: 1.5,
  maxThinkingTokens: 1024,
  maxTurns: 10,
  mcpServers: {},
  model: "claude-opus",
  outputFormat: "json",
  permissionMode: "default",
  permissionPromptToolName: "AskUser",
  persistSession: true,
  planModeInstructions: "be careful",
  plugins: [],
  resume: "session-123",
  resumeSessionAt: "msg-456",
  sandbox: { kind: "none" },
  sessionId: "sess-789",
  sessionStore: { custom: true },
  sessionStoreFlush: "batched",
  settings: { theme: "dark" },
  settingSources: ["user", "project"],
  skills: "all",
  stderr: (_data: string) => undefined,
  strictMcpConfig: true,
  systemPrompt: { type: "preset", preset: "default", append: "extra" },
  thinking: { type: "enabled" },
  tools: { type: "preset", preset: "all" },
};

void _full;
