/**
 * `@lite-harness/sdk` — drop-in replacement for `@anthropic-ai/claude-agent-sdk`.
 *
 * Swap the import and existing Claude Agent SDK code runs unchanged:
 *
 * ```ts
 * // before
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * // after
 * import { query } from "@lite-harness/sdk";
 * ```
 *
 * This module is the entire public surface. Everything else is internal
 * plumbing.
 */

export { query } from "./query.js";
export type { Query } from "./query.js";

export type { Options, PermissionMode } from "./types.js";

export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKResultSubtype,
  SDKPartialAssistantMessage,
} from "./messages.js";

export {
  ClaudeSDKError,
  AbortError,
  CLINotFoundError,
  CLIConnectionError,
  ProcessError,
  CLIJSONDecodeError,
} from "./errors.js";
