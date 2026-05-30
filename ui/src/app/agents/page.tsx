"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Play, Pencil, Trash2, X, Brain } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { BrandIcon } from "@/components/brand-icons";
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
import { Badge } from "@/components/ui/badge";
import {
  listAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  createSession,
  listSkills,
  listIntegrationKeys,
  saveIntegrationKey,
  deleteIntegrationKey,
  listMemory,
  storeMemory,
  deleteMemory,
} from "@/lib/api";
import type { Agent, Skill, Memory } from "@/lib/types";
import {
  slackActionClass,
  slackActionLabel,
  slackConfig,
  useSlackAppFlow,
} from "./slack-app-flow";

interface FormState {
  name: string;
  owner_id: string;
  description: string;
  prompt: string;
  skill_ids: string[];
  vault_keys: string[];
}

const EMPTY: FormState = { name: "", owner_id: "local", description: "", prompt: "", skill_ids: [], vault_keys: [] };

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [vaultKeyInput, setVaultKeyInput] = useState("");
  const [vaultValues, setVaultValues] = useState<Record<string, string>>({});
  const [storedKeys, setStoredKeys] = useState<string[]>([]);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [memKey, setMemKey] = useState("");
  const [memValue, setMemValue] = useState("");
  const slackFlow = useSlackAppFlow(setAgents);

  const load = async () => {
    try {
      setAgents((await listAgents()) as Agent[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    load();
    listSkills().then(setSkills).catch(() => setSkills([]));
    listIntegrationKeys().then(setStoredKeys).catch(() => setStoredKeys([]));
  }, []);

  const addVaultKey = () => {
    const k = vaultKeyInput.trim();
    if (!k) return;
    setForm((f) => (f.vault_keys.includes(k) ? f : { ...f, vault_keys: [...f.vault_keys, k] }));
    setVaultKeyInput("");
  };
  const removeVaultKey = (k: string) => {
    setForm((f) => ({ ...f, vault_keys: f.vault_keys.filter((x) => x !== k) }));
    deleteIntegrationKey(k).then(() => setStoredKeys((p) => p.filter((x) => x !== k))).catch(() => {});
    setVaultValues(({ [k]: _drop, ...rest }) => rest);
  };
  const saveVaultValue = async (k: string) => {
    const v = vaultValues[k];
    if (!v) return;
    try {
      await saveIntegrationKey(k, v);
      setStoredKeys((p) => (p.includes(k) ? p : [...p, k]));
      setVaultValues(({ [k]: _drop, ...rest }) => rest);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleSkill = (id: string) =>
    setForm((f) => ({
      ...f,
      skill_ids: f.skill_ids.includes(id)
        ? f.skill_ids.filter((s) => s !== id)
        : [...f.skill_ids, id],
    }));

  const skillName = (id: string) => skills.find((s) => s.id === id)?.name ?? id;

  const loadMemory = async (agentId: string) => {
    setMemories(null);
    try {
      setMemories(await listMemory(agentId));
    } catch {
      setMemories([]);
    }
  };
  const addMemory = async () => {
    const k = memKey.trim();
    if (!editingId || !k || !memValue.trim()) return;
    try {
      await storeMemory(editingId, k, memValue);
      setMemKey("");
      setMemValue("");
      await loadMemory(editingId);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };
  const removeMemory = async (key: string) => {
    if (!editingId) return;
    setMemories((prev) => prev?.filter((m) => m.key !== key) ?? null);
    try {
      await deleteMemory(editingId, key);
    } catch {
      loadMemory(editingId);
    }
  };

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY);
    setFormError(null);
    setVaultKeyInput("");
    setVaultValues({});
    setMemories([]);
    setMemKey("");
    setMemValue("");
    setOpen(true);
  };
  const openEdit = (ag: Agent) => {
    setEditingId(ag.id);
    setForm({
      name: ag.name ?? "",
      owner_id: (ag.owner_id as string) ?? "local",
      description: ag.description ?? "",
      prompt: ag.prompt ?? "",
      skill_ids: Array.isArray(ag.skill_ids) ? ag.skill_ids : [],
      vault_keys: Array.isArray(ag.vault_keys) ? ag.vault_keys : [],
    });
    setFormError(null);
    setVaultKeyInput("");
    setVaultValues({});
    setMemKey("");
    setMemValue("");
    loadMemory(ag.id);
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
          skill_ids: form.skill_ids,
          vault_keys: form.vault_keys,
        });
      } else {
        await createAgent({
          name: form.name,
          owner_id: form.owner_id || "local",
          description: form.description,
          prompt: form.prompt,
          skill_ids: form.skill_ids,
          vault_keys: form.vault_keys,
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
            {agents?.map((ag) => {
              const slack = slackConfig(ag);
              return (
                <Card
                  key={String(ag.id)}
                  className="p-4 flex items-start justify-between gap-4 cursor-pointer hover:bg-muted/40 transition-colors"
                  onClick={() => router.push(`/agents/detail/?id=${encodeURIComponent(ag.id)}`)}
                >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{String(ag.name)}</span>
                    {Boolean(ag.model) && (
                      <span className="font-mono text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">{String(ag.model)}</span>
                    )}
                  </div>
                  {Boolean(ag.description) && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{String(ag.description)}</p>
                  )}
                  {Boolean(ag.prompt) && (
                    <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-1 font-mono">{String(ag.prompt)}</p>
                  )}
                  {Array.isArray(ag.skill_ids) && ag.skill_ids.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {ag.skill_ids.map((id) => (
                        <Badge key={id} variant="secondary" className="text-[10px]">
                          {skillName(id)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="default" onClick={(e) => { e.stopPropagation(); startSession(ag); }}>
                    <Play className="size-3.5" />
                    Start session
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={slackActionClass(slack)}
                    onClick={(e) => { e.stopPropagation(); slackFlow.openSlack(ag); }}
                    title={
                      slack.status === "connected"
                        ? `${slack.slack_team_name || "Slack"}${slack.bot_user_id ? ` · <@${slack.bot_user_id}>` : ""}`
                        : slack.oauth_error || undefined
                    }
                  >
                    <BrandIcon id="slack" className="size-3.5" />
                    {slackActionLabel(slack)}
                  </Button>
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openEdit(ag); }} aria-label="Edit">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); remove(ag); }} aria-label="Delete">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </Card>
              );
            })}
          </div>
        </main>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[92vw] sm:max-w-2xl max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
            <DialogTitle>{editingId ? "Edit agent" : "New agent"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 py-4 overflow-y-auto">
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
                rows={10}
                placeholder="You are a meticulous security reviewer…"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Skills</Label>
              {skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No skills available on this server.
                </p>
              ) : (
                <div className="max-h-44 overflow-y-auto rounded-md border border-border divide-y divide-border">
                  {skills.map((s) => {
                    const checked = form.skill_ids.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className="flex items-start gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={checked}
                          onChange={() => toggleSkill(s.id)}
                        />
                        <span className="min-w-0 flex flex-col">
                          <span className="text-xs font-medium">{s.name}</span>
                          {s.description && (
                            <span className="text-[11px] text-muted-foreground line-clamp-2">
                              {s.description}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {form.skill_ids.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {form.skill_ids.length} skill{form.skill_ids.length === 1 ? "" : "s"} attached
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Vault credentials</Label>
              <p className="text-[11px] text-muted-foreground -mt-1">
                Secrets this agent can use. Reference them in the prompt as{" "}
                <span className="font-mono">{"{{vault.KEY_NAME}}"}</span>.
              </p>
              <div className="flex gap-2">
                <Input
                  value={vaultKeyInput}
                  onChange={(e) => setVaultKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addVaultKey(); } }}
                  placeholder="BROWSER_USE_API_KEY"
                  className="font-mono text-xs"
                />
                <Button type="button" variant="outline" size="sm" onClick={addVaultKey}>
                  Add
                </Button>
              </div>
              {form.vault_keys.length > 0 && (
                <div className="rounded-md border border-border divide-y divide-border">
                  {form.vault_keys.map((k) => {
                    const isSet = storedKeys.includes(k);
                    return (
                      <div key={k} className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="text-xs font-mono min-w-0 flex-1 truncate">{k}</span>
                        <Badge variant={isSet ? "secondary" : "outline"} className="text-[10px]">
                          {isSet ? "set" : "no value"}
                        </Badge>
                        <Input
                          type="password"
                          value={vaultValues[k] ?? ""}
                          onChange={(e) => setVaultValues((v) => ({ ...v, [k]: e.target.value }))}
                          placeholder={isSet ? "update value" : "set value"}
                          className="h-7 w-36 text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7"
                          disabled={!vaultValues[k]}
                          onClick={() => saveVaultValue(k)}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => removeVaultKey(k)}
                          aria-label={`Remove ${k}`}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {editingId && (
              <div className="grid gap-1.5">
                <Label className="flex items-center gap-1.5">
                  <Brain className="size-3.5" />
                  Memory
                </Label>
                <p className="text-[11px] text-muted-foreground -mt-1">
                  Durable notes this agent stores and recalls across sessions and runs
                  via its <span className="font-mono">memory_*</span> tools.
                </p>
                {memories === null ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : memories.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing remembered yet. The agent fills this in as it works — or add a note below.
                  </p>
                ) : (
                  <div className="rounded-md border border-border divide-y divide-border max-h-52 overflow-y-auto">
                    {memories.map((m) => (
                      <div key={m.key} className="flex items-start gap-2 px-2.5 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-mono font-medium truncate">{m.key}</div>
                          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{m.value}</div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 shrink-0"
                          onClick={() => removeMemory(m.key)}
                          aria-label={`Forget ${m.key}`}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-start">
                  <Input
                    value={memKey}
                    onChange={(e) => setMemKey(e.target.value)}
                    placeholder="key"
                    className="font-mono text-xs w-32 shrink-0"
                  />
                  <Textarea
                    value={memValue}
                    onChange={(e) => setMemValue(e.target.value)}
                    placeholder="value to remember"
                    rows={1}
                    className="text-xs"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addMemory} disabled={!memKey.trim() || !memValue.trim()}>
                    Add
                  </Button>
                </div>
              </div>
            )}
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter className="m-0 rounded-b-xl px-6 py-4">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {slackFlow.dialog}
    </div>
  );
}
