"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  ClipboardCheck,
  Cpu,
  FileText,
  KeyRound,
  Loader2,
  Square,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelSelect } from "@/components/model-select";
import { MessageBlock } from "@/components/message-block";
import { Composer } from "@/components/composer";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sidebar } from "@/components/sidebar";
import { InspectorPanel } from "@/components/inspector-panel";
import { getMessages, getSession, createSession, deleteSession, subscribeEvents, listModels, abortSession, listAgents, listApprovals, acceptApproval, rejectApproval } from "@/lib/api";
import type { PendingApproval } from "@/lib/api";
import { ToolApprovalPanel } from "@/components/tool-approval-panel";
import type { Agent, HarnessMessage, HarnessMessagePart, MessageInfo } from "@/lib/types";
import type { Frame } from "@/components/inspector-panel";

const FALLBACK_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-1",
  "anthropic/claude-haiku-4-5",
];

const BUILTIN_AGENTS: Record<string, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  cc: "Claude Code",
  "github-copilot": "GitHub Copilot",
  codex: "Codex",
};

function agentPrompt(agent: Agent | null): string {
  if (!agent) return "";
  return String(agent.prompt ?? agent.system ?? agent.system_prompt ?? "").trim();
}

function shortPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? compact.slice(0, 220).trimEnd() + "..." : compact;
}

function ChatInner() {
  const sp = useSearchParams();
  const sid = sp.get("id");
  const [messages, setMessages] = useState<HarnessMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0]);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "busy">("idle");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const eventBufferRef = useRef<Frame[]>([]);
  const [sessionHarness, setSessionHarness] = useState<string>("opencode");
  const [sessionTitle, setSessionTitle] = useState<string>("");
  const [savedAgents, setSavedAgents] = useState<Agent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const refetch = useCallback(async () => {
    if (!sid) return;
    try {
      const list = await getMessages(sid);
      // The backend only persists an assistant message once its turn completes,
      // so GET /message omits the in-progress (streaming) assistant turn. A blind
      // setMessages(list) here would wipe the shell created by the message.updated
      // event and drop every subsequent message.part.delta. Merge instead: keep any
      // locally-known messages the server hasn't persisted yet so streaming survives.
      setMessages((prev) => {
        if (!prev) return list;
        const serverIds = new Set(list.map((m) => m.info.id));
        const inflight = prev.filter((m) => !serverIds.has(m.info.id));
        return [...list, ...inflight];
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sid]);

  const router = useRouter();

  const activeAgent = useMemo(() => {
    const target = sessionHarness || sessionTitle;
    return (
      savedAgents.find((a) => a.id === target) ??
      savedAgents.find((a) => a.name === target) ??
      savedAgents.find((a) => sessionTitle && a.name === sessionTitle) ??
      null
    );
  }, [savedAgents, sessionHarness, sessionTitle]);

  const activePrompt = agentPrompt(activeAgent);
  const activeAgentName =
    activeAgent?.name || sessionTitle || BUILTIN_AGENTS[sessionHarness] || sessionHarness;
  const baseRuntime =
    String(activeAgent?.harness ?? activeAgent?.base_agent ?? sessionHarness ?? "opencode");
  const skills = Array.isArray(activeAgent?.skills) ? activeAgent.skills : [];
  const vaultKeys = Array.isArray(activeAgent?.vault_keys) ? activeAgent.vault_keys : [];
  const hasStarted = Boolean(messages && messages.length > 0);
  const agentLocked = hasStarted || Boolean(activeAgent);

  const onCopyPrompt = useCallback(() => {
    if (!activePrompt) return;
    navigator.clipboard?.writeText(activePrompt).then(() => {
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1400);
    }).catch(() => {});
  }, [activePrompt]);

  useEffect(() => {
    listModels().then((fetched) => {
      if (fetched.length > 0) {
        setModels(fetched);
        setModel((prev) => (fetched.includes(prev) ? prev : fetched[0]));
      }
    }).catch(() => {});
  }, []);

  // Fetch session metadata to get the locked agent
  useEffect(() => {
    if (!sid) return;
    getSession(sid).then(s => {
      const a = s.agent_id ?? s.agent ?? s.harness;
      if (a) setSessionHarness(a);
      if (s.title) setSessionTitle(s.title);
    }).catch(() => {});
  }, [sid]);

  // Fetch saved agents for dropdown
  useEffect(() => {
    listAgents().then(setSavedAgents).catch(() => {});
  }, []);

  // On agent change before first message: delete current empty session, create new, redirect
  const onHarnessChange = useCallback(async (next: string) => {
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
        // Buffer every event so inspector can replay history on open
        eventBufferRef.current = [
          ...eventBufferRef.current.slice(-499),
          { ts: Date.now(), ev: ev as Frame["ev"] },
        ];

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
          if (field !== "text" && field !== "reasoning") return;
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
          const errName = (errObj as {name?: string} | undefined)?.name ?? "";
          // MessageAbortedError is raised by our own watchdog abort — not a real failure.
          // Suppress it so the UI doesn't show a scary error card for auto-aborted turns.
          if (errName === "MessageAbortedError") {
            setSessionStatus("idle");
            refetch();
            return;
          }
          const msg = (errObj as {data?: {message?: string}} | undefined)?.data?.message
            ?? (errObj as {message?: string} | undefined)?.message
            ?? JSON.stringify(errObj ?? ev.properties);
          setError(`Error: ${msg}`);
          setSessionStatus("idle");
          refetch();
        } else if (ev.type === "tool.approval.requested") {
          const { id, tool, arguments: args, createdAt } = ev.properties as unknown as PendingApproval;
          if (!id) return;
          setApprovals((prev) =>
            prev.some((a) => a.id === id) ? prev : [...prev, { id, tool, arguments: args ?? {}, createdAt }],
          );
        } else if (ev.type === "tool.approval.resolved") {
          const { id } = ev.properties as { id?: string };
          if (id) setApprovals((prev) => prev.filter((a) => a.id !== id));
        }
      },
    });
    // Catch up on any approvals already pending before this client connected.
    listApprovals().then(setApprovals).catch(() => {});
    return unsub;
  }, [sid, refetch]);

  const onApprovalAccept = useCallback(async (id: string, args: Record<string, unknown>) => {
    setApprovalBusy(true);
    try {
      await acceptApproval(id, args);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalBusy(false);
    }
  }, []);

  const onApprovalReject = useCallback(async (id: string, feedback: string) => {
    setApprovalBusy(true);
    try {
      await rejectApproval(id, feedback);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalBusy(false);
    }
  }, []);

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
            {sessionTitle && (
              <span className="text-sm font-medium" title={sessionTitle}>{sessionTitle}</span>
            )}
            <span className="text-xs font-mono text-muted-foreground">{shortSid}</span>
            {sessionStatus === "busy" ? (
              <button
                onClick={() => sid && abortSession(sid).catch(() => {})}
                className="flex items-center gap-1 text-[11px] text-amber-500 font-mono hover:text-red-500 transition-colors group"
                title="Abort agent"
              >
                <Loader2 className="w-3 h-3 animate-spin group-hover:hidden" />
                <Square className="w-3 h-3 hidden group-hover:block fill-current" />
                <span className="group-hover:hidden">busy</span>
                <span className="hidden group-hover:inline">abort</span>
              </button>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                idle
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">agent</span>
              {agentLocked ? (
                <span
                  className="h-8 max-w-[220px] px-3 flex items-center text-xs font-mono border border-border rounded-md bg-muted text-muted-foreground truncate"
                  title={activeAgentName}
                >
                  {activeAgentName}
                </span>
              ) : (
                <Select value={sessionHarness} onValueChange={(v) => v && onHarnessChange(v)}>
                  <SelectTrigger className="h-8 text-xs w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opencode" className="text-xs font-mono">opencode</SelectItem>
                    <SelectItem value="claude-code" className="text-xs font-mono">claude code</SelectItem>
                    <SelectItem value="github-copilot" className="text-xs font-mono">github copilot</SelectItem>
                    {savedAgents.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-t mt-1 pt-2">Saved agents</div>
                        {savedAgents.map(a => (
                          <SelectItem key={a.id} value={a.id} className="text-xs font-mono">{a.name}</SelectItem>
                        ))}
                      </>
                    )}
                    <div className="px-2 py-2 text-[10px] text-muted-foreground border-t mt-1">
                      💡 Say <span className="font-mono">&quot;save this agent&quot;</span> to save a session
                    </div>
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">model</span>
              <ModelSelect value={model} models={models} onValueChange={setModel} />
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
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
            {!messages && !error && (
              <div className="text-muted-foreground text-sm">Loading…</div>
            )}
            {error && (
              <Card className="border-destructive p-4">
                <p className="text-sm text-destructive">{error}</p>
              </Card>
            )}
            <Card className="gap-0 overflow-hidden rounded-lg border border-border/80 bg-card/80 py-0 ring-0">
              <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
                <section className="min-w-0 border-b border-border/70 p-4 md:border-b-0 md:border-r">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <Bot className="size-4 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-sm font-semibold leading-5">{activeAgentName}</h2>
                        {activePrompt ? (
                          <span className="inline-flex h-5 items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-500">
                            <CheckCircle2 className="size-3" />
                            prompt active
                          </span>
                        ) : (
                          <span className="inline-flex h-5 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-500">
                            <AlertTriangle className="size-3" />
                            no saved prompt
                          </span>
                        )}
                      </div>
                      {activeAgent?.description ? (
                        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                          {String(activeAgent.description)}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Session instructions and runtime context are shown before the transcript.
                        </p>
                      )}
                      <div className="mt-3 grid gap-1.5 text-[11px] sm:grid-cols-2">
                        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1.5">
                          <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">runtime</span>
                          <span className="ml-auto truncate font-mono text-foreground">{baseRuntime}</span>
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1.5">
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">session</span>
                          <span className="ml-auto truncate font-mono text-foreground">{shortSid}</span>
                        </div>
                      </div>
                      {(skills.length > 0 || vaultKeys.length > 0) && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {skills.map((skill) => (
                            <span
                              key={skill}
                              className="inline-flex h-5 items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-1.5 font-mono text-[10px] text-sky-500"
                            >
                              <Wrench className="size-3" />
                              {skill}
                            </span>
                          ))}
                          {vaultKeys.map((key) => (
                            <span
                              key={key}
                              className="inline-flex h-5 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 font-mono text-[10px] text-amber-500"
                            >
                              <KeyRound className="size-3" />
                              {key}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                <section className="min-w-0 bg-background/35 p-4">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium">System prompt</div>
                      <div className="text-[11px] text-muted-foreground">
                        {activePrompt ? "Visible before the first turn runs." : "No reusable agent prompt is attached."}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={!activePrompt}
                        onClick={onCopyPrompt}
                        aria-label="Copy system prompt"
                        title="Copy system prompt"
                      >
                        {promptCopied ? <ClipboardCheck className="size-3.5" /> : <Clipboard className="size-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => setPromptOpen((v) => !v)}
                        disabled={!activePrompt}
                        title={promptOpen ? "Collapse system prompt" : "Expand system prompt"}
                      >
                        <span>{promptOpen ? "Full" : "Preview"}</span>
                        <ChevronDown className={`size-3.5 transition-transform ${promptOpen ? "rotate-180" : ""}`} />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3">
                    {activePrompt ? (
                      promptOpen ? (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground">
                          {activePrompt}
                        </pre>
                      ) : (
                        <div className="rounded-md border border-border bg-background p-3">
                          <p className="line-clamp-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
                            {shortPrompt(activePrompt)}
                          </p>
                        </div>
                      )
                    ) : (
                      <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-500">
                        {activeAgent
                          ? "This saved agent will run without a stored system prompt until one is added on the Agents page."
                          : "This is a built-in runtime session, so there is no saved agent prompt to review."}
                      </div>
                    )}
                  </div>
                  {promptCopied && (
                    <div className="mt-2 text-[11px] text-emerald-500">
                      Copied system prompt.
                    </div>
                  )}
                </section>
              </div>
            </Card>
            {messages && messages.length === 0 && (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No messages yet. Say hi.
              </div>
            )}
            {messages?.map((m, i) => (
              <MessageBlock
                key={(m.info.id as string | undefined) ?? i}
                msg={m}
              />
            ))}
            {approvals.map((a) => (
              <ToolApprovalPanel
                key={a.id}
                approval={a}
                onAccept={onApprovalAccept}
                onReject={onApprovalReject}
                busy={approvalBusy}
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
        initialFrames={eventBufferRef.current}
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
