"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Sidebar } from "@/components/sidebar";
import { InspectorPanel } from "@/components/inspector-panel";
import { getMessages, getSession, createSession, deleteSession, subscribeEvents } from "@/lib/api";
import type { HarnessMessage, HarnessMessagePart, MessageInfo } from "@/lib/types";

const MODELS = [
  "anthropic/claude-opus-4-7",
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
  const [sessionStatus, setSessionStatus] = useState<"idle" | "busy">("idle");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sessionHarness, setSessionHarness] = useState<"opencode" | "claude-code">("opencode");
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

  const router = useRouter();

  // Fetch session metadata to get the locked harness
  useEffect(() => {
    if (!sid) return;
    getSession(sid).then(s => {
      if (s.harness === "claude-code" || s.harness === "opencode") setSessionHarness(s.harness);
    }).catch(() => {});
  }, [sid]);

  // On harness change before first message: delete current empty session, create new, redirect
  const onHarnessChange = useCallback(async (next: "opencode" | "claude-code") => {
    if (!sid || next === sessionHarness) return;
    await deleteSession(sid);
    const s = await createSession(undefined, next);
    router.replace(`/chat/?id=${encodeURIComponent(s.id)}`);
  }, [sid, sessionHarness, router]);

  useEffect(() => {
    if (!sid) return;
    refetch();
    const unsub = subscribeEvents({
      sessionId: sid,
      onEvent: (raw) => {
        const ev = raw as { type: string; properties: Record<string, unknown> };

        if (ev.type === "message.updated") {
          const info = ev.properties.info as MessageInfo;
          if (!info?.id) return;
          setMessages((prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((m) => m.info.id === info.id);
            if (idx === -1) return [...prev, { info, parts: [] }];
            const next = [...prev];
            next[idx] = { ...next[idx], info: { ...next[idx].info, ...info } };
            return next;
          });
        } else if (ev.type === "message.part.updated") {
          const part = ev.properties.part as HarnessMessagePart;
          const msgId = part.messageID;
          if (!msgId || !part.id || part.type === "step-start" || part.type === "step-finish") return;
          setMessages((prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((m) => m.info.id === msgId);
            if (idx === -1) return prev;
            const msg = prev[idx];
            const pIdx = msg.parts.findIndex((p) => p.id === part.id);
            const newParts = [...msg.parts];
            if (pIdx === -1) newParts.push(part);
            else newParts[pIdx] = part;
            const next = [...prev];
            next[idx] = { ...msg, parts: newParts };
            return next;
          });
        } else if (ev.type === "message.part.delta") {
          const { messageID, partID, field, delta } = ev.properties as {
            messageID: string;
            partID: string;
            field: string;
            delta: string;
          };
          if (field !== "text") return;
          setMessages((prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((m) => m.info.id === messageID);
            if (idx === -1) return prev;
            const msg = prev[idx];
            const pIdx = msg.parts.findIndex((p) => p.id === partID);
            if (pIdx === -1) return prev;
            const part = msg.parts[pIdx] as HarnessMessagePart & { text: string };
            const newParts = [...msg.parts];
            newParts[pIdx] = { ...part, text: (part.text ?? "") + delta } as HarnessMessagePart;
            const next = [...prev];
            next[idx] = { ...msg, parts: newParts };
            return next;
          });
        } else if (ev.type === "session.status") {
          const st = (ev.properties?.status as { type?: string } | undefined)?.type;
          if (st === "busy" || st === "idle") setSessionStatus(st);
        } else if (ev.type === "session.idle") {
          setSessionStatus("idle");
          refetch();
        } else if (ev.type === "session.error") {
          const errObj = ev.properties?.error as Record<string, unknown> | undefined;
          const msg = (errObj as {data?: {message?: string}} | undefined)?.data?.message
            ?? (errObj as {message?: string} | undefined)?.message
            ?? JSON.stringify(errObj ?? ev.properties);
          setError(`Error: ${msg}`);
          setSessionStatus("idle");
          refetch();
        }
      },
    });
    return unsub;
  }, [sid, refetch]);

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
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Missing <code className="font-mono mx-1">?id=</code> parameter.
        </div>
      </div>
    );
  }

  const shortSid = sid.length > 12 ? sid.slice(0, 12) + "…" : sid;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar activeId={sid} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{shortSid}</span>
            {sessionStatus === "busy" ? (
              <span className="flex items-center gap-1 text-[11px] text-amber-500 font-mono">
                <Loader2 className="w-3 h-3 animate-spin" />
                busy
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                idle
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">harness</span>
              {messages && messages.length > 0 ? (
                <span className="h-8 px-3 flex items-center text-xs font-mono border border-border rounded-md bg-muted text-muted-foreground">{sessionHarness}</span>
              ) : (
                <Select value={sessionHarness} onValueChange={(v) => v && onHarnessChange(v as "opencode" | "claude-code")}>
                  <SelectTrigger className="h-8 text-xs w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opencode" className="text-xs font-mono">opencode</SelectItem>
                    <SelectItem value="claude-code" className="text-xs font-mono">claude code</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">model</span>
              <Select value={model} onValueChange={(v) => v && setModel(v)}>
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
            </div>
            <Button
              variant={inspectorOpen ? "default" : "outline"}
              size="sm"
              onClick={() => setInspectorOpen((v) => !v)}
              className="h-8"
            >
              <Activity className="size-3.5" />
              Inspect
            </Button>
            <ThemeToggle />
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

      <InspectorPanel
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={sid}
      />
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
