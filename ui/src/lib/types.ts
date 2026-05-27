export interface OpencodeSession {
  id: string;
  title?: string;
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

export type HarnessMessagePart =
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
  | { type: "step-start" };

export interface HarnessMessage {
  info: MessageInfo;
  parts: HarnessMessagePart[];
}
