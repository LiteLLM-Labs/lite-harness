"use client";

/**
 * Inspect tab — per-session debugging surface that subscribes to the
 * harness event bus (`GET /event`) and renders every event scoped to the
 * current session, plus the global lifecycle events (`server.connected`,
 * `server.heartbeat`) so connection state is visible.
 *
 * Mirrors LAP's interceptions-panel concept, but the data source is the
 * raw bus stream instead of vault interceptions (lite-harness has no
 * vault sidecar).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

const MAX_BUFFER = 200;
const GLOBAL_TYPES = new Set(["server.connected", "server.heartbeat"]);

interface BufferedEvent {
  key: number;
  ts: number;
  type: string;
  raw: unknown;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const msStr = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${msStr}`;
}

function EventRow({ ev }: { ev: BufferedEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-accent/40 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">
          {formatTimestamp(ev.ts)}
        </span>
        <span className="font-mono text-[11px] text-foreground truncate">
          {ev.type}
        </span>
      </button>
      {open && (
        <pre className="border-t border-border bg-muted/30 px-3 py-2 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(ev.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function InspectPanel({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<BufferedEvent[]>([]);
  const counterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    if (!sessionId) return;
    let es: EventSource | null = null;
    try {
      es = new EventSource("/event");
    } catch {
      return;
    }
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const type =
          typeof data?.type === "string" ? (data.type as string) : "unknown";
        const evSid =
          (data?.properties?.sessionID as string | undefined) ??
          (data?.properties?.info?.sessionID as string | undefined);
        if (!GLOBAL_TYPES.has(type) && evSid && evSid !== sessionId) return;
        if (!GLOBAL_TYPES.has(type) && !evSid) {
          // Untagged non-global event — skip; not addressed to any session.
          return;
        }
        counterRef.current += 1;
        const key = counterRef.current;
        setEvents((prev) => {
          const next = [...prev, { key, ts: Date.now(), type, raw: data }];
          if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER);
          return next;
        });
      } catch {
        /* ignore parse errors */
      }
    };
    return () => {
      try {
        es?.close();
      } catch {
        /* noop */
      }
    };
  }, [sessionId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    wasNearBottomRef.current = dist < 120;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  const count = events.length;
  const subtitle = useMemo(() => {
    if (count === 0) return "Waiting for events…";
    return `${count} event${count === 1 ? "" : "s"} (max ${MAX_BUFFER})`;
  }, [count]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-[11px] font-mono text-muted-foreground">
          {subtitle}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setEvents([])}
          disabled={count === 0}
        >
          Clear
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-4 py-3 flex flex-col gap-1.5">
          {count === 0 && (
            <p className="text-muted-foreground text-sm text-center py-12">
              No events yet. Send a message to see bus traffic.
            </p>
          )}
          {events.map((ev) => (
            <EventRow key={ev.key} ev={ev} />
          ))}
        </div>
      </div>
    </div>
  );
}
