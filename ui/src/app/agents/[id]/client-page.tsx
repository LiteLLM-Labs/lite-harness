"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Play, Trash2, Clock } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getAgent, deleteAgent, createSession, listSessions } from "@/lib/api";
import type { Agent, OpencodeSession } from "@/lib/types";

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function AgentDetailPage({ id }: { id: string }) {
  const router = useRouter();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessions, setSessions] = useState<OpencodeSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [ag, allSessions] = await Promise.all([getAgent(id), listSessions()]);
        setAgent(ag);
        setSessions(allSessions.filter((s) => s.agent === id || s.harness === id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const handleDelete = async () => {
    if (!agent) return;
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await deleteAgent(id);
      router.push("/agents/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleStartSession = async () => {
    if (!agent) return;
    try {
      const sess = await createSession(agent.name, id);
      router.push(`/chat/?id=${encodeURIComponent(sess.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push("/agents/")}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Agents
            </Button>
            {agent && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="text-sm font-semibold truncate max-w-[240px]">{agent.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {agent && (
              <>
                <Button size="sm" variant="default" onClick={handleStartSession}>
                  <Play className="size-3.5" />
                  Start session
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push(`/agents/${encodeURIComponent(id)}/edit`)}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={handleDelete} aria-label="Delete">
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-6">
            {error && (
              <Card className="border-destructive p-3">
                <p className="text-sm text-destructive">{error}</p>
              </Card>
            )}
            {loading && (
              <div className="text-sm text-muted-foreground">Loading…</div>
            )}

            {agent && (
              <>
                {/* Hero */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-xl font-semibold">{agent.name}</h1>
                    {agent.model && (
                      <span className="text-xs font-mono bg-muted text-muted-foreground rounded px-2 py-0.5">
                        {String(agent.model)}
                      </span>
                    )}
                  </div>
                  {agent.description && (
                    <p className="text-sm text-muted-foreground">{agent.description}</p>
                  )}
                  {agent.created_at && (
                    <p className="text-xs text-muted-foreground/60 flex items-center gap-1 mt-1">
                      <Clock className="size-3" />
                      Created {timeAgo(Number(agent.created_at) * 1000)}
                    </p>
                  )}
                </div>

                {/* Configuration */}
                <section>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Configuration
                  </h2>
                  <Card className="p-4">
                    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
                      <dt className="text-muted-foreground font-medium">ID</dt>
                      <dd className="font-mono text-xs text-muted-foreground break-all">{agent.id}</dd>

                      {agent.model && (
                        <>
                          <dt className="text-muted-foreground font-medium">Model</dt>
                          <dd className="font-mono text-xs">{String(agent.model)}</dd>
                        </>
                      )}

                      {agent.owner_id && (
                        <>
                          <dt className="text-muted-foreground font-medium">Owner</dt>
                          <dd className="font-mono text-xs">{String(agent.owner_id)}</dd>
                        </>
                      )}

                      {agent.prompt && (
                        <>
                          <dt className="text-muted-foreground font-medium pt-1">System prompt</dt>
                          <dd>
                            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                              {String(agent.prompt)}
                            </pre>
                          </dd>
                        </>
                      )}
                    </dl>
                  </Card>
                </section>

                {/* Sessions */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Sessions ({sessions.length})
                    </h2>
                    <Button size="sm" variant="outline" onClick={handleStartSession}>
                      <Play className="size-3" />
                      New session
                    </Button>
                  </div>
                  {sessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sessions yet.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {sessions.map((s) => (
                        <Card
                          key={s.id}
                          className="px-4 py-3 flex items-center justify-between gap-2 cursor-pointer hover:bg-muted/40 transition-colors"
                          onClick={() => router.push(`/chat/?id=${encodeURIComponent(s.id)}`)}
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{s.title ?? "Untitled session"}</p>
                            <p className="font-mono text-[10px] text-muted-foreground mt-0.5">{s.id}</p>
                          </div>
                          {s.time?.created && (
                            <span className="text-xs text-muted-foreground shrink-0">
                              {timeAgo(s.time.created * 1000)}
                            </span>
                          )}
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
