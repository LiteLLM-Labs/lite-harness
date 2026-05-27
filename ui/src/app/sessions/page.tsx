"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  createSession,
  deleteSession,
  listSessions,
} from "@/lib/api";
import type { OpencodeSession } from "@/lib/types";

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<OpencodeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const list = await listSessions();
      setSessions(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onNew = async () => {
    setCreating(true);
    try {
      const s = await createSession();
      router.push(`/chat/?id=${encodeURIComponent(s.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (id: string) => {
    setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
    await deleteSession(id);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button onClick={onNew} disabled={creating}>
              <Plus className="size-4" />
              New session
            </Button>
          </div>
        </div>
        <Separator className="mb-6" />

        {error && (
          <Card className="border-destructive p-4 mb-4">
            <p className="text-sm text-destructive mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </Card>
        )}

        {!sessions && !error && (
          <p className="text-muted-foreground text-sm">Loading…</p>
        )}

        {sessions && sessions.length === 0 && !error && (
          <p className="text-muted-foreground text-sm">
            No sessions yet. Click <span className="font-medium">+ New session</span> to start.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {sessions?.map((s) => {
            const short = s.id.length > 16 ? s.id.slice(0, 16) + "…" : s.id;
            const title = s.title?.trim() || short;
            return (
              <Card
                key={s.id}
                className="group flex flex-row items-center justify-between p-4 hover:border-foreground/20 cursor-pointer transition-colors"
                onClick={() =>
                  router.push(`/chat/?id=${encodeURIComponent(s.id)}`)
                }
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{title}</span>
                  <span className="text-xs text-muted-foreground font-mono mt-0.5">
                    {short}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-4">
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(s.time?.created)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.id);
                    }}
                    aria-label="Delete session"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
