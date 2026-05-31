"use client";

import { useEffect, useState } from "react";
import { KeyRound, Trash2, Pencil, Plus, Loader2, Eye, EyeOff } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  listVaultKeys,
  saveIntegrationKey,
  deleteIntegrationKey,
} from "@/lib/api";
import type { VaultKeyEntry } from "@/lib/api";

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type EditorState =
  | { mode: "add" }
  | { mode: "edit"; entry: VaultKeyEntry };

export default function VaultPage() {
  const [keys, setKeys] = useState<VaultKeyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showEnv, setShowEnv] = useState(false);

  const refresh = async () => {
    try {
      setKeys(await listVaultKeys());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onDelete = async (key: string) => {
    setKeys((prev) => prev?.filter((k) => k.key !== key) ?? null);
    await deleteIntegrationKey(key);
    await refresh();
  };

  const vaultKeys = keys?.filter((k) => k.source !== "env") ?? [];
  const envKeys = keys?.filter((k) => k.source === "env") ?? [];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Vault</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setEditor({ mode: "add" })}>
              <Plus className="size-4" />
              Add secret
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {keys === null && !error && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}

          {keys !== null && vaultKeys.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <KeyRound className="size-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No secrets stored yet.</p>
              <Button size="sm" onClick={() => setEditor({ mode: "add" })}>
                <Plus className="size-4" />
                Add your first secret
              </Button>
            </div>
          )}

          {vaultKeys.length > 0 && (
            <div className="max-w-2xl space-y-2">
              {vaultKeys.map((entry) => (
                <SecretRow
                  key={entry.key}
                  entry={entry}
                  onEdit={() => setEditor({ mode: "edit", entry })}
                  onDelete={() => onDelete(entry.key)}
                />
              ))}
            </div>
          )}

          {keys !== null && envKeys.length > 0 && (
            <div className="mt-6 max-w-2xl">
              <button
                onClick={() => setShowEnv((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>{showEnv ? "▾" : "▸"}</span>
                <span>{envKeys.length} environment variable{envKeys.length !== 1 ? "s" : ""} available as secrets</span>
              </button>
              {showEnv && (
                <div className="mt-2 space-y-1.5">
                  {envKeys.map((entry) => (
                    <SecretRow
                      key={entry.key}
                      entry={entry}
                      onEdit={() => setEditor({ mode: "edit", entry })}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      <VaultEditor
        state={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          refresh();
        }}
      />
    </div>
  );
}

function SecretRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: VaultKeyEntry;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const isEnv = entry.source === "env";
  const hasTimestamp = (entry.updated_at ?? 0) > 0;

  return (
    <div className={`group flex items-center justify-between rounded-lg border px-4 py-3 ${isEnv ? "border-border/50 bg-muted/20" : "border-border bg-card"}`}>
      <div className="min-w-0 flex-1">
        <div className={`font-mono text-sm font-medium ${isEnv ? "text-muted-foreground" : ""}`}>{entry.key}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono tracking-widest">••••••••</span>
          {hasTimestamp && <span>· updated {timeAgo(entry.updated_at)}</span>}
          {isEnv && (
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide">env</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          aria-label={`Edit ${entry.key}`}
          title={isEnv ? "Override with vault value" : "Edit"}
        >
          <Pencil className="size-3.5" />
        </Button>
        {!isEnv && onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete ${entry.key}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function VaultEditor({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [keyName, setKeyName] = useState("");
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = state?.mode === "edit";
  const open = state !== null;

  useEffect(() => {
    if (state?.mode === "edit") {
      setKeyName(state.entry.key);
    } else {
      setKeyName("");
    }
    setValue("");
    setReveal(false);
    setError(null);
  }, [state]);

  const onSave = async () => {
    const k = keyName.trim();
    const v = value.trim();
    if (!k || !v) return;
    setSaving(true);
    setError(null);
    try {
      await saveIntegrationKey(k, v);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Update secret" : "Add secret"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Enter a new value to overwrite the existing secret."
              : "Store a secret in the encrypted vault. The value is never displayed after saving."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Key name
            </label>
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. GITHUB_TOKEN"
              className="font-mono"
              disabled={isEdit}
              autoComplete="off"
              autoFocus={!isEdit}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Value
            </label>
            <div className="relative">
              <Input
                type={reveal ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={isEdit ? "Enter new value…" : "Enter secret value…"}
                className="pr-9 font-mono"
                autoComplete="off"
                autoFocus={isEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSave();
                }}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={reveal ? "Hide value" : "Show value"}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <Button
            onClick={onSave}
            disabled={saving || !keyName.trim() || !value.trim()}
            className="w-full"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : isEdit ? (
              "Update"
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
