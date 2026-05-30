"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Play, Pencil, Trash2 } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listApiAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  createSession,
} from "@/lib/api";
import type { Agent } from "@/lib/types";

interface FormState {
  name: string;
  owner_id: string;
  description: string;
  prompt: string;
}

const EMPTY: FormState = { name: "", owner_id: "local", description: "", prompt: "" };

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    try {
      setAgents(await listApiAgents());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY);
    setFormError(null);
    setOpen(true);
  };
  const openEdit = (ag: Agent) => {
    setEditingId(ag.id);
    setForm({
      name: ag.name ?? "",
      owner_id: (ag.owner_id as string) ?? "local",
      description: ag.description ?? "",
      prompt: ag.prompt ?? "",
    });
    setFormError(null);
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      if (editingId) {
        await updateAgent(editingId, {
          name: form.name,
          description: form.description,
          prompt: form.prompt,
        });
      } else {
        await createAgent({
          name: form.name,
          owner_id: form.owner_id || "local",
          description: form.description,
          prompt: form.prompt,
        });
      }
      setOpen(false);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ag: Agent) => {
    if (!confirm(`Delete agent "${String(ag.name)}"?`)) return;
    setAgents((prev) => prev?.filter((x) => x.id !== ag.id) ?? null);
    try {
      await deleteAgent(ag.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const startSession = async (ag: Agent) => {
    try {
      const sess = await createSession(ag.name, ag.id);
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
          <h1 className="text-sm font-semibold">Agents</h1>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={openNew}>
              <Plus className="size-4" />
              New agent
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-3">
            {error && (
              <Card className="border-destructive p-3">
                <p className="text-sm text-destructive">{error}</p>
              </Card>
            )}
            {!agents && !error && (
              <div className="text-sm text-muted-foreground">Loading…</div>
            )}
            {agents && agents.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-16">
                No agents yet. Click <span className="font-medium">New agent</span> to define one.
              </div>
            )}
            {agents?.map((ag) => (
              <Card key={String(ag.id)} className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{String(ag.name)}</span>
                    {Boolean(ag.base_agent) && (
                      <span className="font-mono text-[10px] text-muted-foreground">{String(ag.base_agent)}</span>
                    )}
                  </div>
                  {Boolean(ag.description) && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{String(ag.description)}</p>
                  )}
                  {Boolean(ag.prompt) && (
                    <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-2 font-mono">{String(ag.prompt)}</p>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground mt-1">{String(ag.id)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="default" onClick={() => startSession(ag)}>
                    <Play className="size-3.5" />
                    Start session
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openEdit(ag)} aria-label="Edit">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => remove(ag)} aria-label="Delete">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </main>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit agent" : "New agent"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ag-name">Name</Label>
              <Input
                id="ag-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="security-reviewer"
              />
            </div>
            {!editingId && (
              <div className="grid gap-1.5">
                <Label htmlFor="ag-owner">Owner ID</Label>
                <Input
                  id="ag-owner"
                  value={form.owner_id}
                  onChange={(e) => setForm({ ...form, owner_id: e.target.value })}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="ag-desc">Description</Label>
              <Input
                id="ag-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this agent does"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ag-prompt">System prompt</Label>
              <Textarea
                id="ag-prompt"
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                rows={6}
                placeholder="You are a meticulous security reviewer…"
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
