"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, X } from "lucide-react";

interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface Frame {
  ts: number;
  ev: OcEvent;
}

function summarize(ev: OcEvent): string {
  const p = (ev.properties ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "server.connected":
      return "stream connected";
    case "session.idle":
      return "agent loop returned control";
    case "session.error":
      return String((p.message as string) ?? "error");
    case "message.updated": {
      const info = (p.info ?? {}) as { role?: string; id?: string };
      return `${info.role ?? "?"} ${(info.id ?? "").slice(0, 22)}`;
    }
    case "message.part.delta":
      return `${(p.field as string) ?? "text"}: ${String(p.delta ?? "").slice(0, 80)}`;
    case "message.part.updated": {
      const part = (p.part ?? {}) as {
        type?: string;
        tool?: string;
        text?: string;
        state?: { status?: string };
      };
      if (part.type === "tool")
        return `tool ${part.tool ?? "?"} · ${part.state?.status ?? ""}`;
      if (part.type === "text")
        return `text: ${String(part.text ?? "").slice(0, 80)}`;
      if (part.type === "reasoning")
        return `reasoning: ${String(part.text ?? "").slice(0, 80)}`;
      return `part ${part.type ?? "?"}`;
    }
    case "session.status": {
      const s = p.status as { type?: string } | string | undefined;
      return typeof s === "string" ? s : (s?.type ?? "");
    }
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 80) : "";
  }
}

const TYPE_COLOR: Record<string, string> = {
  "server.connected": "text-emerald-600",
  "session.idle": "text-amber-600",
  "session.error": "text-red-600",
  "session.status": "text-violet-600",
  "message.updated": "text-violet-600",
  "message.part.delta": "text-sky-600",
  "message.part.updated": "text-blue-600",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString([], { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function EventRow({ frame, currentSid }: { frame: Frame; currentSid?: string | null }) {
  const [open, setOpen] = useState(false);
  const color = TYPE_COLOR[frame.ev.type] ?? "text-foreground/70";
  const sid = (frame.ev.properties as { sessionID?: string } | undefined)
    ?.sessionID;
  const isSub = !!sid && !!currentSid && sid !== currentSid;
  return (
    <div className="border-b border-border text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-accent/50 ${
          isSub ? "bg-amber-500/5" : ""
        }`}
      >
        <ChevronRight
          className={`mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-mono text-muted-foreground shrink-0">
          {fmtTime(frame.ts)}
        </span>
        {isSub && (
          <span className="font-mono text-[9px] shrink-0 px-1 rounded bg-amber-200 text-amber-900">
            subagent
          </span>
        )}
        <span className={`font-mono font-medium shrink-0 ${color}`}>
          {frame.ev.type}
        </span>
        <span className="font-mono text-muted-foreground truncate">
          {summarize(frame.ev)}
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-2 pl-8 font-mono text-[10.5px] text-muted-foreground whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {JSON.stringify(frame.ev, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function InspectorPanel({
  open,
  onClose,
  sessionId,
  initialFrames = [],
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  initialFrames?: Frame[];
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hideHeartbeat, setHideHeartbeat] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Seed with buffered events from before the panel opened
    setFrames(initialFrames.slice(-500));
    let es: EventSource | null = null;
    try {
      es = new EventSource("/event");
    } catch {
      return;
    }
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as OcEvent;
        setFrames((prev) => [...prev.slice(-999), { ts: Date.now(), ev }]);
      } catch {
        /* noop */
      }
    };
    return () => {
      try {
        es?.close();
      } catch {
        /* noop */
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]); // intentionally omit initialFrames — snapshot on open only

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frames]);

  if (!open) return null;

  const shown = hideHeartbeat
    ? frames.filter((f) => f.ev.type !== "server.heartbeat")
    : frames;

  return (
    <aside className="flex flex-col h-screen min-h-0 border-l border-border bg-background w-[480px] shrink-0">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <Activity className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">opencode events</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {sessionId.slice(0, 8)}…
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 hover:bg-accent rounded"
          title="Close inspector"
        >
          <X className="size-4 text-muted-foreground" />
        </button>
      </header>

      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-muted/30 text-[11px]">
        <label className="inline-flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={hideHeartbeat}
            onChange={(e) => setHideHeartbeat(e.target.checked)}
            className="size-3"
          />
          hide heartbeats
        </label>
        <button
          type="button"
          onClick={() => setFrames([])}
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          clear
        </button>
        <span className="ml-auto text-muted-foreground font-mono">
          {shown.length} events
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {shown.map((f, i) => (
          <EventRow key={i} frame={f} currentSid={sessionId} />
        ))}
        {shown.length === 0 && (
          <div className="p-3 text-[11px] text-muted-foreground text-center leading-relaxed">
            subscribed to /event
            <br />
            events appear as the agent loop emits them
          </div>
        )}
      </div>

      <footer className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground font-mono">
        GET /event
      </footer>
    </aside>
  );
}
