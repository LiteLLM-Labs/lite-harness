"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Copy, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/api";
import { cn } from "@/lib/utils";

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
    <section className="rounded-lg border border-amber-500/25 bg-card">
      <div className="flex flex-col gap-3 border-b border-amber-500/20 bg-amber-500/[0.04] p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-amber-500/25 bg-amber-500/10 text-amber-300">
            <ShieldAlert className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{approval.tool}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Review and edit arguments before allowing this tool call.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300">
            <AlertCircle className="size-3" />
            Awaiting approval
          </span>
          <Button variant="outline" size="sm" onClick={copyName}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Arguments</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Changes are returned to the agent exactly as approved.
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFields(initial)}
            disabled={busy || !dirty}
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
        </div>

        {keys.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
            This action takes no arguments.
          </div>
        ) : (
          <div className="space-y-3">
            {keys.map((k) => (
              <div key={k} className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{toFieldLabel(k)}</label>
                <textarea
                  value={fields[k]}
                  onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                  rows={fields[k].includes("\n") ? Math.min(fields[k].split("\n").length, 8) : 1}
                  className={cn(
                    "w-full resize-y rounded-md border border-input bg-input/30 px-3 py-2 font-mono text-sm outline-none transition-colors",
                    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={() => onAccept(approval.id, buildArgs())} disabled={busy}>
            <CheckCircle2 className="size-3.5" />
            Accept
          </Button>
        </div>

        <div className="my-4 border-t border-border" />

        <div className="mb-2 flex items-center gap-2">
          <XCircle className="size-4 text-destructive" />
          <div>
            <div className="text-sm font-semibold">Reject with feedback</div>
            <div className="mt-0.5 text-xs text-muted-foreground">The agent receives this text and can adjust its next step.</div>
          </div>
        </div>

        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="Explain what needs to change before this action is allowed."
          className="w-full resize-y rounded-md border border-input bg-input/30 px-3 py-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
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
    </section>
  );
}
