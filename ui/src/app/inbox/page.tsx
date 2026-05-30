"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  Inbox as InboxIcon,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ToolApprovalPanel } from "@/components/tool-approval-panel";
import { cn } from "@/lib/utils";
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

function formatTimestamp(ts?: number | null): string {
  if (!ts) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

const TABS: { key: InboxFilter; label: string }[] = [
  { key: "attention", label: "Needs Attention" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

function matchesFilter(item: InboxItem, filter: InboxFilter): boolean {
  if (filter === "all") return true;
  const needsAttention = item.status === "pending" || item.status === "open";
  return filter === "attention" ? needsAttention : !needsAttention;
}

const STATUS_META: Record<
  InboxItem["status"],
  { label: string; tone: string; icon: typeof AlertCircle }
> = {
  pending: {
    label: "Approval pending",
    tone: "border-amber-500/35 bg-amber-500/10 text-amber-300",
    icon: AlertCircle,
  },
  open: {
    label: "Open issue",
    tone: "border-sky-500/35 bg-sky-500/10 text-sky-300",
    icon: MessageSquare,
  },
  accepted: {
    label: "Accepted",
    tone: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
    icon: CheckCircle2,
  },
  rejected: {
    label: "Rejected",
    tone: "border-red-500/35 bg-red-500/10 text-red-300",
    icon: AlertCircle,
  },
  resolved: {
    label: "Resolved",
    tone: "border-border bg-muted/60 text-muted-foreground",
    icon: CheckCircle2,
  },
};

function StatusTag({ item }: { item: InboxItem }) {
  const status = STATUS_META[item.status] ?? {
    label: item.status,
    tone: "border-border bg-muted/60 text-muted-foreground",
    icon: Circle,
  };
  const Icon = status.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
        status.tone,
      )}
    >
      <Icon className="size-3" />
      {status.label}
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

function shortSession(id?: string | null): string {
  if (!id) return "No session";
  return id.length > 14 ? id.slice(0, 14) : id;
}

export default function InboxPage() {
  const router = useRouter();
  const [tab, setTab] = useState<InboxFilter>("attention");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const load = useCallback(async (t: InboxFilter) => {
    try {
      const list = await listInbox("all");
      const visible = list.filter((item) => matchesFilter(item, t));
      setItems(list);
      setSelectedId((cur) => (cur && visible.some((i) => i.id === cur) ? cur : visible[0]?.id ?? null));
      setLastUpdated(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    load(tab);
    const t = setInterval(() => load(tab), 4000);
    return () => clearInterval(t);
  }, [tab, load]);

  const visibleItems = useMemo(() => (items ?? []).filter((item) => matchesFilter(item, tab)), [items, tab]);
  const selected = visibleItems.find((i) => i.id === selectedId) ?? null;
  const counts = useMemo(() => {
    const list = items ?? [];
    const attention = list.filter((i) => i.status === "pending" || i.status === "open").length;
    const completed = list.filter((i) => i.status !== "pending" && i.status !== "open").length;
    return {
      attention,
      completed,
      all: list.length,
      approvals: list.filter((i) => i.kind === "approval").length,
      issues: list.filter((i) => i.kind === "issue").length,
    };
  }, [items]);

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
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <InboxIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Inbox</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              Human decisions and agent-filed follow-ups
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
              <Clock3 className="size-3.5" />
              {lastUpdated ? `Updated ${timeAgo(lastUpdated)} ago` : "Waiting for sync"}
            </div>
            <Button variant="ghost" size="icon" onClick={() => load(tab)} className="size-8" aria-label="Refresh inbox">
              <RefreshCw className="size-3.5" />
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <div className="border-b border-border bg-muted/20 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground">Needs Attention</div>
              <div className="mt-1 flex items-end justify-between">
                <span className="text-2xl font-semibold">{counts.attention}</span>
                <AlertCircle className="size-4 text-amber-400" />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground">Approvals</div>
              <div className="mt-1 flex items-end justify-between">
                <span className="text-2xl font-semibold">{counts.approvals}</span>
                <CheckCircle2 className="size-4 text-emerald-400" />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground">Issues</div>
              <div className="mt-1 flex items-end justify-between">
                <span className="text-2xl font-semibold">{counts.issues}</span>
                <MessageSquare className="size-4 text-sky-400" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {TABS.map((t) => {
            const count = t.key === "attention" ? counts.attention : t.key === "completed" ? counts.completed : counts.all;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  tab === t.key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {t.label}
                <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-[240px] border-b border-border lg:min-h-0 lg:w-[420px] lg:min-w-[360px] lg:flex-col lg:border-b-0 lg:border-r">
            <div className="hidden items-center justify-between border-b border-border px-4 py-2 text-[11px] text-muted-foreground lg:flex">
              <span>{items ? `${visibleItems.length} item${visibleItems.length === 1 ? "" : "s"}` : "Syncing"}</span>
              <span>Newest first</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {error && (
                <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              {items && visibleItems.length === 0 && (
                <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
                  <CheckCircle2 className="mb-3 size-8 text-muted-foreground" />
                  <div className="text-sm font-medium">
                    {tab === "attention" ? "Nothing needs attention" : "No items in this view"}
                  </div>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                    Approvals and filed issues will appear here with their originating session.
                  </p>
                </div>
              )}
              {visibleItems.map((item) => {
                const active = item.id === selectedId;
                const Icon = item.kind === "approval" ? AlertCircle : MessageSquare;
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      "flex w-full flex-col gap-2 border-b border-border/70 px-4 py-3 text-left transition-colors",
                      active ? "bg-accent/80" : "hover:bg-accent/40",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
                          item.kind === "approval"
                            ? "border-amber-500/25 bg-amber-500/10 text-amber-300"
                            : "border-sky-500/25 bg-sky-500/10 text-sky-300",
                        )}
                      >
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{item.title}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{timeAgo(item.createdAt)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <StatusTag item={item} />
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {item.agent ?? "agent"} · {shortSession(item.sessionId)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {preview(item) && (
                      <p className="line-clamp-2 pl-11 text-xs leading-5 text-muted-foreground">{preview(item)}</p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <main className="min-w-0 flex-1 overflow-y-auto">
            {!selected ? (
              <div className="flex h-full min-h-[360px] items-center justify-center px-6 text-sm text-muted-foreground">
                Select an item to review.
              </div>
            ) : (
              <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5 lg:px-6">
                <section className="rounded-lg border border-border bg-card">
                  <div className="flex flex-col gap-4 border-b border-border p-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <StatusTag item={selected} />
                        <span className="rounded-md border border-border bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                          {selected.kind === "approval" ? "Blocking approval" : "Filed issue"}
                        </span>
                      </div>
                      <h1 className="truncate text-lg font-semibold leading-6">{selected.title}</h1>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{selected.agent ?? "Agent"}</span>
                        <span>Created {formatTimestamp(selected.createdAt)}</span>
                        {selected.resolvedAt && <span>Closed {formatTimestamp(selected.resolvedAt)}</span>}
                      </div>
                    </div>
                    {selected.sessionId && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/chat/?id=${encodeURIComponent(selected.sessionId!)}`)}
                        className="w-full justify-center md:w-auto"
                      >
                        <ExternalLink className="size-3.5" />
                        Open session
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-0 divide-y divide-border text-xs md:grid-cols-3 md:divide-x md:divide-y-0">
                    <div className="px-4 py-3">
                      <div className="text-muted-foreground">Session</div>
                      <div className="mt-1 truncate font-mono text-foreground">{shortSession(selected.sessionId)}</div>
                    </div>
                    <div className="px-4 py-3">
                      <div className="text-muted-foreground">Item ID</div>
                      <div className="mt-1 truncate font-mono text-foreground">{selected.id}</div>
                    </div>
                    <div className="px-4 py-3">
                      <div className="text-muted-foreground">Age</div>
                      <div className="mt-1 text-foreground">{timeAgo(selected.createdAt)} old</div>
                    </div>
                  </div>
                </section>

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

                {selected.kind === "approval" && selected.status !== "pending" && (
                  <section className="rounded-lg border border-border bg-card p-4">
                    <div className="mb-3 text-sm font-semibold">Approval record</div>
                    {selected.args && Object.keys(selected.args).length > 0 ? (
                      <div className="space-y-3">
                        {Object.entries(selected.args).map(([k, v]) => (
                          <div key={k}>
                            <div className="text-xs font-medium text-muted-foreground">{k}</div>
                            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                              {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">This action had no arguments.</p>
                    )}
                    {selected.feedback && (
                      <div className="mt-4 border-t border-border pt-4">
                        <div className="text-xs font-medium text-muted-foreground">Feedback to agent</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{selected.feedback}</p>
                      </div>
                    )}
                  </section>
                )}

                {selected.kind === "issue" && (
                  <section className="space-y-4">
                    <div className="rounded-lg border border-border bg-card p-4">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <MessageSquare className="size-4 text-sky-300" />
                        Issue details
                      </div>
                      {selected.body ? (
                        <p className="whitespace-pre-wrap text-sm leading-6">{selected.body}</p>
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
                  </section>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
