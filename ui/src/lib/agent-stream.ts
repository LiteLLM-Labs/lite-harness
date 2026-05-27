import type { HarnessMessage, HarnessMessagePart, MessageInfo } from "./types";

interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

function upsertMessage(
  msgs: HarnessMessage[],
  id: string,
  mut: (m: HarnessMessage) => HarnessMessage,
  fallbackInfo?: Partial<MessageInfo>,
): HarnessMessage[] {
  const idx = msgs.findIndex((m) => m.info.id === id);
  if (idx >= 0) return msgs.map((m, i) => (i === idx ? mut(m) : m));
  const seed: HarnessMessage = {
    info: { id, role: "assistant", ...fallbackInfo } as MessageInfo,
    parts: [],
  };
  return [...msgs, mut(seed)];
}

function upsertPart(
  parts: HarnessMessagePart[],
  partID: string,
  build: (prev: HarnessMessagePart | undefined) => HarnessMessagePart,
): HarnessMessagePart[] {
  const idx = parts.findIndex((p) => p.id === partID);
  if (idx >= 0) return parts.map((p, i) => (i === idx ? build(p) : p));
  return [...parts, build(undefined)];
}

/**
 * Fold one opencode `/event` frame into the running messages list. Mirrors
 * LAP's agent-state reducer but produces HarnessMessage[] (what MessageBlock
 * already renders) so the chat streams in lock-step with the inspector.
 */
export function applyOpencodeEvent(
  msgs: HarnessMessage[],
  ev: OcEvent,
): HarnessMessage[] {
  const p = ev.properties ?? {};
  switch (ev.type) {
    case "message.updated": {
      const info = p.info as MessageInfo | undefined;
      if (!info?.id) return msgs;
      return upsertMessage(
        msgs,
        info.id,
        (m) => ({ ...m, info: { ...m.info, ...info } }),
        info,
      );
    }
    case "message.part.delta": {
      const messageID = p.messageID as string | undefined;
      const partID = p.partID as string | undefined;
      const delta = p.delta as string | undefined;
      const field = p.field as string | undefined;
      if (!messageID || !partID || delta === undefined) return msgs;
      if (field !== "text" && field !== "thinking" && field !== "reasoning")
        return msgs;
      return upsertMessage(msgs, messageID, (m) => ({
        ...m,
        parts: upsertPart(m.parts, partID, (prev) => {
          const prevText =
            prev && "text" in prev && typeof prev.text === "string"
              ? prev.text
              : "";
          return {
            id: partID,
            type: field,
            text: prevText + delta,
          } as HarnessMessagePart;
        }),
      }));
    }
    case "message.part.updated": {
      const part = p.part as
        | (HarnessMessagePart & { messageID?: string; id?: string })
        | undefined;
      const messageID =
        part?.messageID ?? (p.messageID as string | undefined);
      if (!messageID || !part?.id) return msgs;
      const partID = part.id;
      return upsertMessage(msgs, messageID, (m) => ({
        ...m,
        parts: upsertPart(m.parts, partID, () => part as HarnessMessagePart),
      }));
    }
    default:
      return msgs;
  }
}

/** Seed from `GET /session/:id/message` so a client joining mid-history isn't blank. */
export function seedFromHistory(history: HarnessMessage[]): HarnessMessage[] {
  return history.map((h) => ({
    info: h.info,
    parts: Array.isArray(h.parts) ? h.parts : [],
  }));
}
