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
