"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Puzzle, FileText, Bot, Inbox } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/settings-dialog";
import { readHarness } from "@/lib/use-harness";
import { createSession, deleteSession, listSessions, listInbox } from "@/lib/api";
import type { OpencodeSession } from "@/lib/types";

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function Sidebar({ activeId }: { activeId?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<OpencodeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const load = async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Poll the needs-attention count for the unread badge.
  useEffect(() => {
    const loadCount = () =>
      listInbox("attention")
        .then((items) => setInboxCount(items.length))
        .catch(() => {});
    loadCount();
    const t = setInterval(loadCount, 5000);
    return () => clearInterval(t);
  }, [pathname]);

  const onNew = async () => {
    setCreating(true);
    try {
      const s = await createSession(undefined, readHarness());
      router.push(`/chat/?id=${encodeURIComponent(s.id)}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
    await deleteSession(id);
    if (id === activeId) router.push("/sessions/");
  };

  return (
    <aside className="flex h-screen w-16 shrink-0 flex-col border-r border-border bg-background sm:w-64">
      <div className="flex h-12 items-center justify-center border-b border-border px-2 sm:justify-between sm:px-4">
        <div
          className="flex min-w-0 cursor-pointer items-center gap-2"
          onClick={() => router.push("/sessions/")}
        >
          <span className="text-xl leading-none">🚄</span>
          <span className="hidden text-sm font-semibold sm:inline">LiteLLM</span>
        </div>
        <div className="hidden sm:block">
          <SettingsDialog />
        </div>
      </div>

      <div className="space-y-2 border-b border-border px-2 py-3 sm:px-3">
        <Button
          onClick={onNew}
          disabled={creating}
          className="relative w-full justify-center sm:justify-start"
          size="sm"
          aria-label="New session"
        >
          <Plus className="size-4" />
          <span className="hidden sm:inline">New session</span>
        </Button>
        <Button
          onClick={() => router.push("/inbox/")}
          variant={pathname?.startsWith("/inbox") ? "secondary" : "ghost"}
          className="relative w-full justify-center sm:justify-start"
          size="sm"
          aria-label="Inbox"
        >
          <Inbox className="size-4" />
          <span className="hidden sm:inline">Inbox</span>
          {inboxCount > 0 && (
            <span className="absolute ml-7 mt-[-18px] flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white sm:static sm:ml-auto sm:mt-0 sm:h-5 sm:min-w-5 sm:px-1.5 sm:text-[11px]">
              {inboxCount}
            </span>
          )}
        </Button>
        <Button
          onClick={() => router.push("/agents/")}
          variant={pathname?.startsWith("/agents") ? "secondary" : "ghost"}
          className="w-full justify-center sm:justify-start"
          size="sm"
          aria-label="Agents"
        >
          <Bot className="size-4" />
          <span className="hidden sm:inline">Agents</span>
        </Button>
        <Button
          onClick={() => router.push("/integrations/")}
          variant={pathname?.startsWith("/integrations") ? "secondary" : "ghost"}
          className="w-full justify-center sm:justify-start"
          size="sm"
          aria-label="Integrations"
        >
          <Puzzle className="size-4" />
          <span className="hidden sm:inline">Integrations</span>
        </Button>
        <Button
          onClick={() => router.push("/skills/")}
          variant={pathname?.startsWith("/skills") ? "secondary" : "ghost"}
          className="w-full justify-center sm:justify-start"
          size="sm"
          aria-label="Skills"
        >
          <FileText className="size-4" />
          <span className="hidden sm:inline">Skills</span>
        </Button>
      </div>

      <div className="hidden flex-1 overflow-y-auto py-2 sm:block">
        {error && (
          <div className="px-3 py-2 text-xs text-destructive">{error}</div>
        )}
        {!sessions && !error && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {sessions && sessions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No sessions yet.
          </div>
        )}
        {sessions?.map((s) => {
          const short = s.id.slice(0, 12);
          const title = s.title?.trim() || short;
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              onClick={() => router.push(`/chat/?id=${encodeURIComponent(s.id)}`)}
              className={`group mx-2 px-2 py-1.5 rounded text-xs cursor-pointer flex items-center justify-between gap-2 ${
                active
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{title}</div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">
                  {(s.agent ?? s.harness) === "claude-code" ? "cc" : (s.agent ?? s.harness) === "github-copilot" ? "gh" : "oc"} · {short} · {timeAgo(s.time?.created)}
                </div>
              </div>
              <button
                onClick={(e) => onDelete(e, s.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-background rounded"
                aria-label="Delete session"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
