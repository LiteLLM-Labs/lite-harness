export interface OpencodeSession {
  id: string;
  title?: string;
  agent?: string;
  /** @deprecated use agent */
  harness?: string;
  time?: { created: number; updated?: number };
  [k: string]: unknown;
}

export interface MessageInfo {
  id?: string;
  role: "user" | "assistant";
  finish?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  time?: { created?: number; completed?: number };
  providerID?: string;
  modelID?: string;
  sessionID?: string;
  [k: string]: unknown;
}

interface PartBase {
  id?: string;
  messageID?: string;
  sessionID?: string;
}

export type HarnessMessagePart = PartBase &
  (
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string; time?: { start?: number; end?: number } }
    | { type: "thinking"; text: string; time?: { start?: number; end?: number } }
    | {
        type: "tool";
        tool: string;
        state: {
          status: string;
          input?: unknown;
          output?: unknown;
          error?: unknown;
          [k: string]: unknown;
        };
      }
    | { type: "step-start" }
    | { type: "step-finish"; [k: string]: unknown }
  );

export interface HarnessMessage {
  info: MessageInfo;
  parts: HarnessMessagePart[];
}

export interface Agent {
  id: string;
  name: string;
  model?: string;
  prompt?: string;
  description?: string;
  cron?: string | null;
  timezone?: string | null;
  status?: string;
  owner_id?: string | null;
  /** IDs of DB-backed skills attached to this agent (agents.skill_ids). */
  skill_ids?: string[];
  vault_keys?: string[];
  created_at?: number;
  [k: string]: unknown;
}

/** A reusable, DB-backed skill (capability doc) attachable to an agent. */
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  owner_id: string | null;
  created_at: number;
}

/** A durable key→value note an agent has stored in its memory. */
export interface Memory {
  id: string;
  agent_id: string;
  key: string;
  value: string;
  always_on?: boolean | number;
  created_at: number;
  updated_at: number;
}
