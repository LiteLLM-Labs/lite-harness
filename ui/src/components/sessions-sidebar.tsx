"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createSession,
  deleteSession,
  listSessions,
} from "@/lib/api";
import type { OpencodeSession } from "@/lib/types";

const REFRESH_MS = 10_000;

export function SessionsSidebar({ activeSid }: { activeSid: string }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<OpencodeSession[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
    } catch {
      /* swallow — sidebar is a non-critical surface */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const onNew = async () => {
    setCreating(true);
    try {
      const s = await createSession();
      router.push(`/chat/?id=${encodeURIComponent(s.id)}`);
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;
    await deleteSession(id);
    if (id === activeSid) {
      router.push("/sessions/");
      return;
    }
    void load();
  };

  return (
    <aside className="hidden md:flex w-[260px] shrink-0 flex-col border-r border-border bg-background">
      <div className="h-12 flex items-center px-3 border-b border-border shrink-0">
        <Button
          onClick={onNew}
          disabled={creating}
          size="sm"
          variant="outline"
          className="w-full justify-start h-8 text-xs"
        >
          <Plus className="size-3.5" />
          New session
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {!sessions && (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        )}
        {sessions && sessions.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No sessions yet.
          </p>
        )}
        {sessions?.map((s) => {
          const short = s.id.length > 16 ? s.id.slice(0, 16) + "…" : s.id;
          const title = s.title?.trim() || short;
          const active = s.id === activeSid;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                router.push(`/chat/?id=${encodeURIComponent(s.id)}`)
              }
              className={cn(
                "group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 text-foreground",
              )}
            >
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-xs font-medium truncate">{title}</span>
                <span className="text-[10px] font-mono text-muted-foreground truncate">
                  {short}
                </span>
              </div>
              <button
                type="button"
                aria-label="Delete session"
                onClick={(e) => onDelete(e, s.id)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity shrink-0 p-1 -mr-1"
              >
                <Trash2 className="size-3.5" />
              </button>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
