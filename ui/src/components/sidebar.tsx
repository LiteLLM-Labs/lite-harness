"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/settings-dialog";
import { readHarness } from "@/lib/use-harness";
import { createSession, deleteSession, listSessions } from "@/lib/api";
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
  const [sessions, setSessions] = useState<OpencodeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    <aside className="w-64 shrink-0 border-r border-border bg-background flex flex-col h-screen">
      <div className="flex items-center justify-between px-4 h-12 border-b border-border">
        <div
          className="flex items-center gap-2 cursor-pointer min-w-0"
          onClick={() => router.push("/sessions/")}
        >
          <span className="text-xl leading-none">🚄</span>
          <span className="font-semibold text-sm">LiteLLM</span>
        </div>
        <SettingsDialog />
      </div>

      <div className="px-3 py-3 border-b border-border">
        <Button
          onClick={onNew}
          disabled={creating}
          className="w-full justify-start"
          size="sm"
        >
          <Plus className="size-4" />
          New session
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
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
                  {s.harness === "claude-code" ? "cc" : s.harness === "github-copilot" ? "gh" : "oc"} · {short} · {timeAgo(s.time?.created)}
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
