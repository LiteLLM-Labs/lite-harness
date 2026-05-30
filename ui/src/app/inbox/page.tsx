"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Inbox as InboxIcon, MessageSquare, RefreshCw, ExternalLink } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ToolApprovalPanel } from "@/components/tool-approval-panel";
import {
  listInbox,
  acceptApproval,
  rejectApproval,
  resolveInboxItem,
  type InboxItem,
  type InboxFilter,
} from "@/lib/api";

function timeAgo(ts?: number | null): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

const TABS: { key: InboxFilter; label: string }[] = [
  { key: "attention", label: "Needs Attention" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

function StatusTag({ item }: { item: InboxItem }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "Needs approval", cls: "text-amber-600 bg-amber-500/10 border-amber-500/30" },
    open: { label: "Issue", cls: "text-sky-600 bg-sky-500/10 border-sky-500/30" },
    accepted: { label: "Accepted", cls: "text-emerald-600 bg-emerald-500/10 border-emerald-500/30" },
    rejected: { label: "Rejected", cls: "text-red-600 bg-red-500/10 border-red-500/30" },
    resolved: { label: "Resolved", cls: "text-muted-foreground bg-muted border-border" },
  };
  const s = map[item.status] ?? { label: item.status, cls: "text-muted-foreground bg-muted border-border" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {item.status === "pending" || item.status === "open" ? (
        <AlertCircle className="size-3" />
      ) : (
        <CheckCircle2 className="size-3" />
      )}
      {s.label}
    </span>
  );
}

function preview(item: InboxItem): string {
  if (item.body) return item.body;
  if (item.args) {
    const v = Object.values(item.args)[0];
    if (typeof v === "string") return v;
    if (v != null) return JSON.stringify(v);
  }
  return "";
}

export default function InboxPage() {
  const router = useRouter();
  const [tab, setTab] = useState<InboxFilter>("attention");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (t: InboxFilter) => {
    try {
      const list = await listInbox(t);
      setItems(list);
      setSelectedId((cur) => (cur && list.some((i) => i.id === cur) ? cur : list[0]?.id ?? null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load(tab);
    const t = setInterval(() => load(tab), 4000);
    return () => clearInterval(t);
  }, [tab, load]);

  const selected = items?.find((i) => i.id === selectedId) ?? null;

  const onAccept = useCallback(async (id: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      await acceptApproval(id, args);
      await load(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  const onReject = useCallback(async (id: string, feedback: string) => {
    setBusy(true);
    try {
      await rejectApproval(id, feedback);
      await load(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  const onResolve = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await resolveInboxItem(id);
      await load(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <InboxIcon className="size-4" />
            <span className="text-sm font-semibold">Inbox</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => load(tab)} className="h-8">
              <RefreshCw className="size-3.5" />
            </Button>
            <ThemeToggle />
          </div>
        </header>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* List */}
          <div className="flex w-[40%] min-w-[320px] flex-col border-r border-border">
            <div className="flex items-center justify-between px-4 py-2 text-[11px] text-muted-foreground">
              <span>{items ? `${items.length} item${items.length === 1 ? "" : "s"}` : "…"}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {error && <div className="px-4 py-3 text-xs text-destructive">{error}</div>}
              {items && items.length === 0 && (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {tab === "attention" ? "Nothing needs your attention." : "No items."}
                </div>
              )}
              {items?.map((item) => {
                const active = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`flex w-full flex-col gap-1.5 border-b border-border/60 px-4 py-3 text-left transition-colors ${
                      active ? "bg-accent" : "hover:bg-accent/40"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {item.kind === "approval" ? (
                        <AlertCircle className="size-4 shrink-0 text-amber-500" />
                      ) : (
                        <MessageSquare className="size-4 shrink-0 text-sky-500" />
                      )}
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{timeAgo(item.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusTag item={item} />
                      <span className="truncate text-xs text-muted-foreground">{item.agent ?? "Agent"}</span>
                    </div>
                    {preview(item) && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{preview(item)}</p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detail */}
          <div className="flex-1 overflow-y-auto">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Select an item to review.
              </div>
            ) : (
              <div className="mx-auto max-w-2xl px-6 py-6">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold">{selected.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <StatusTag item={selected} />
                      <span>{selected.agent ?? "Agent"}</span>
                      <span>· {timeAgo(selected.createdAt)} ago</span>
                    </div>
                  </div>
                  {selected.sessionId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/chat/?id=${encodeURIComponent(selected.sessionId!)}`)}
                    >
                      <ExternalLink className="size-3.5" />
                      Open session
                    </Button>
                  )}
                </div>

                {/* Pending approval → editable accept/reject panel */}
                {selected.kind === "approval" && selected.status === "pending" && (
                  <ToolApprovalPanel
                    approval={{
                      id: selected.id,
                      tool: selected.title,
                      arguments: selected.args ?? {},
                      createdAt: selected.createdAt,
                    }}
                    onAccept={onAccept}
                    onReject={onReject}
                    busy={busy}
                  />
                )}

                {/* Resolved approval → read-only summary */}
                {selected.kind === "approval" && selected.status !== "pending" && (
                  <div className="space-y-4 rounded-xl border border-border bg-card p-4">
                    {selected.args && Object.keys(selected.args).length > 0 && (
                      <div className="space-y-2">
                        {Object.entries(selected.args).map(([k, v]) => (
                          <div key={k}>
                            <div className="text-xs text-muted-foreground">{k}</div>
                            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 px-3 py-2 font-mono text-xs">
                              {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                    {selected.feedback && (
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">Feedback to agent</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{selected.feedback}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Issue → body + resolve */}
                {selected.kind === "issue" && (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-border bg-card p-4">
                      {selected.body ? (
                        <p className="whitespace-pre-wrap text-sm leading-relaxed">{selected.body}</p>
                      ) : (
                        <p className="text-sm text-muted-foreground">No details provided.</p>
                      )}
                    </div>
                    {selected.status === "open" && (
                      <div className="flex justify-end">
                        <Button size="sm" onClick={() => onResolve(selected.id)} disabled={busy}>
                          <CheckCircle2 className="size-3.5" />
                          Mark resolved
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
