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
  | { id?: string; type: "text"; text: string }
  | {
      id?: string;
      type: "reasoning";
      text: string;
      time?: { start?: number; end?: number };
    }
  | {
      id?: string;
      type: "thinking";
      text: string;
      time?: { start?: number; end?: number };
    }
  | {
      id?: string;
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
  | { id?: string; type: "step-start" };

export interface HarnessMessage {
  info: MessageInfo;
  parts: HarnessMessagePart[];
}
