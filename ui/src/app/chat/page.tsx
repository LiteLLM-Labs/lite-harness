"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MessageBlock } from "@/components/message-block";
import { Composer } from "@/components/composer";
import { ThemeToggle } from "@/components/theme-toggle";
import { getMessages, subscribeEvents } from "@/lib/api";
import type { HarnessMessage } from "@/lib/types";

const MODELS = [
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-1",
  "anthropic/claude-haiku-4-5",
];

function ChatInner() {
  const sp = useSearchParams();
  const sid = sp.get("id");
  const [messages, setMessages] = useState<HarnessMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(MODELS[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!sid) return;
    try {
      const list = await getMessages(sid);
      setMessages(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sid]);

  useEffect(() => {
    if (!sid) return;
    refetch();
    const unsub = subscribeEvents({
      sessionId: sid,
      onEvent: () => refetch(),
    });
    return unsub;
  }, [sid, refetch]);

  // Fallback poll while a turn is in flight.
  useEffect(() => {
    if (!sid || !messages) return;
    const last = messages[messages.length - 1];
    const inFlight =
      last?.info.role === "assistant" && last.info.finish !== "stop";
    if (!inFlight) return;
    const t = setInterval(refetch, 2000);
    return () => clearInterval(t);
  }, [sid, messages, refetch]);

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
  }, [messages]);

  if (!sid) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        Missing <code className="font-mono mx-1">?id=</code> parameter.
      </div>
    );
  }

  const shortSid = sid.length > 12 ? sid.slice(0, 12) + "…" : sid;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 h-12 flex items-center justify-between">
          <a
            href="/sessions/"
            className="text-xs font-mono text-muted-foreground hover:text-foreground"
          >
            ← {shortSid}
          </a>
          <div className="flex items-center gap-2">
            <Select
              value={model}
              onValueChange={(v) => v && setModel(v)}
            >
              <SelectTrigger className="h-8 text-xs w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs font-mono">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4">
          {!messages && !error && (
            <div className="text-muted-foreground text-sm">Loading…</div>
          )}
          {error && (
            <Card className="border-destructive p-4">
              <p className="text-sm text-destructive">{error}</p>
            </Card>
          )}
          {messages && messages.length === 0 && (
            <div className="text-muted-foreground text-sm text-center py-12">
              No messages yet. Say hi.
            </div>
          )}
          {messages?.map((m, i) => (
            <MessageBlock
              key={(m.info.id as string | undefined) ?? i}
              msg={m}
            />
          ))}
        </div>
      </div>

      <Composer sessionId={sid} model={model} onSent={refetch} />
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
          Loading…
        </div>
      }
    >
      <ChatInner />
    </Suspense>
  );
}
