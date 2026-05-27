"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { HarnessMessage, HarnessMessagePart } from "@/lib/types";

function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolKv({ label, value }: { label: string; value: unknown }) {
  const s = stringify(value);
  if (!s) return null;
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
        {label}
      </div>
      <pre className="font-mono text-xs bg-muted/40 border border-border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-words">
        {truncate(s)}
      </pre>
    </div>
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "error") return "destructive";
  return "secondary";
}

function PartBlock({ part }: { part: HarnessMessagePart }) {
  if (part.type === "text") {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
      </div>
    );
  }
  if (part.type === "reasoning" || part.type === "thinking") {
    const dur =
      part.time?.start && part.time?.end
        ? ` (${((part.time.end - part.time.start) / 1000).toFixed(1)}s)`
        : "";
    return (
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
          Thinking{dur}
        </summary>
        <div className="mt-2 italic text-muted-foreground whitespace-pre-wrap pl-3 border-l border-border">
          {part.text}
        </div>
      </details>
    );
  }
  if (part.type === "tool") {
    const status = part.state?.status ?? "unknown";
    return (
      <Card className="p-3">
        <details>
          <summary className="cursor-pointer flex items-center gap-2 select-none">
            <span className="font-mono text-sm text-primary">{part.tool}</span>
            <Badge variant={statusVariant(status)}>{status}</Badge>
          </summary>
          <ToolKv label="input" value={part.state?.input} />
          <ToolKv label="output" value={part.state?.output} />
          {part.state?.error != null && (
            <ToolKv label="error" value={part.state?.error} />
          )}
        </details>
      </Card>
    );
  }
  if (part.type === "step-start") {
    return <div className="border-t border-dashed border-border my-3 h-0" />;
  }
  return null;
}

function UserPromptBlock({ msg }: { msg: HarnessMessage }) {
  const text = msg.parts
    .filter((p): p is Extract<HarnessMessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return (
    <div className="flex justify-end">
      <Card
        className={cn(
          "bg-card border-border rounded-md px-4 py-2 ml-auto max-w-[80%]",
        )}
      >
        <div className="whitespace-pre-wrap text-sm">{text}</div>
      </Card>
    </div>
  );
}

function AssistantBlock({ msg }: { msg: HarnessMessage }) {
  const inProgress = msg.info.finish !== "stop";
  const tokens = msg.info.tokens;
  return (
    <div className="flex flex-col gap-2">
      {msg.parts.map((part, i) => (
        <PartBlock key={i} part={part} />
      ))}
      {inProgress && (
        <div className="text-xs text-muted-foreground italic">Thinking…</div>
      )}
      {!inProgress && (tokens?.input != null || tokens?.output != null) && (
        <div className="text-xs text-muted-foreground">
          {tokens?.input ?? 0} in / {tokens?.output ?? 0} out
        </div>
      )}
    </div>
  );
}

export function MessageBlock({ msg }: { msg: HarnessMessage }) {
  if (msg.info.role === "user") return <UserPromptBlock msg={msg} />;
  return <AssistantBlock msg={msg} />;
}
