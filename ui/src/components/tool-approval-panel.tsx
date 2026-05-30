"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Copy, RotateCcw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/api";

function toFieldLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

// Re-parse a field's edited text back into the original value's type so an
// edited object stays an object, an edited number stays a number, etc.
function fromStringValue(original: unknown, text: string): unknown {
  if (typeof original === "string" || original === null || original === undefined) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ToolApprovalPanelProps {
  approval: PendingApproval;
  onAccept: (id: string, args: Record<string, unknown>) => void;
  onReject: (id: string, feedback: string) => void;
  busy?: boolean;
}

export function ToolApprovalPanel({ approval, onAccept, onReject, busy }: ToolApprovalPanelProps) {
  const initial = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(approval.arguments ?? {})) out[k] = toStringValue(v);
    return out;
  }, [approval]);

  const [fields, setFields] = useState<Record<string, string>>(initial);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);

  const keys = Object.keys(approval.arguments ?? {});
  const dirty = keys.some((k) => fields[k] !== initial[k]);

  const buildArgs = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = fromStringValue(approval.arguments[k], fields[k]);
    return out;
  };

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(approval.tool);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="my-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.03] p-1">
      {/* Header — tool name + copy */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <AlertCircle className="size-5 text-amber-500" />
        <span className="text-lg font-semibold tracking-tight">{approval.tool}</span>
        <Button variant="outline" size="sm" onClick={copyName} className="ml-1">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">awaiting approval</span>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/40 p-4">
        <div className="mb-3 text-sm font-semibold">Edit/Accept</div>

        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">This action takes no arguments.</p>
        ) : (
          <div className="space-y-3">
            {keys.map((k) => (
              <div key={k} className="space-y-1.5">
                <label className="text-sm text-muted-foreground">{toFieldLabel(k)}</label>
                <textarea
                  value={fields[k]}
                  onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                  rows={fields[k].includes("\n") ? Math.min(fields[k].split("\n").length, 8) : 1}
                  className="w-full resize-y rounded-lg border border-input bg-input/30 px-3 py-2 font-mono text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFields(initial)}
            disabled={busy || !dirty}
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={() => onAccept(approval.id, buildArgs())} disabled={busy}>
            Accept
          </Button>
        </div>

        {/* Reject path */}
        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <span className="text-xs text-muted-foreground">Or tell the agent what it did wrong</span>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="Feedback returned to the agent on reject…"
          className="w-full resize-y rounded-lg border border-input bg-input/30 px-3 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          disabled={busy}
        />

        <div className="mt-3 flex justify-end">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onReject(approval.id, feedback.trim())}
            disabled={busy}
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
