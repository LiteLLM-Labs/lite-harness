"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronDown,
  Loader2,
  Wrench,
  X,
} from "lucide-react";
import type { HarnessMessage, HarnessMessagePart } from "@/lib/types";

// Adapter: derive the local-message shape LAP's components consume from our
// HarnessMessage (which carries info + parts). Sub-threads / permissions /
// attachments are not supported here.
interface LocalMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  parts: HarnessMessagePart[];
  status?: "queued" | "in_progress" | "completed" | "failed";
  error?: string;
  latency_ms?: number;
}

function toLocal(m: HarnessMessage): LocalMessage {
  const role = m.info.role;
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const text = parts
    .filter((p): p is Extract<HarnessMessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  let status: LocalMessage["status"];
  let latency_ms: number | undefined;
  if (role === "assistant") {
    const finish = m.info.finish;
    if (!finish) {
      status = "in_progress";
    } else if (finish === "stop" || finish === "end_turn") {
      status = "completed";
    } else {
      status = "completed";
    }
    const created = m.info.time?.created;
    const completed = m.info.time?.completed;
    if (typeof created === "number" && typeof completed === "number") {
      latency_ms = completed - created;
    }
  }
  return {
    id: (m.info.id as string | undefined) ?? "",
    role,
    text,
    parts,
    status,
    latency_ms,
  };
}

function InnerMessageBlock({
  msg,
  isFirstUser,
  onCancelQueued,
}: {
  msg: LocalMessage;
  isFirstUser: boolean;
  onCancelQueued?: (msgId: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <UserPromptBlock
        content={msg.text ?? ""}
        emphasized={isFirstUser}
      />
    );
  }
  return <AssistantBlock msg={msg} onCancelQueued={onCancelQueued} />;
}

function UserPromptBlock({
  content,
  emphasized,
}: {
  content: string;
  emphasized: boolean;
}) {
  return (
    <div
      className={`bg-muted/30 border border-border rounded-xl p-4 text-[14px] text-foreground leading-relaxed ${
        emphasized ? "shadow-sm" : ""
      }`}
    >
      {content && <div className="whitespace-pre-wrap">{content}</div>}
    </div>
  );
}

function AssistantBlock({
  msg,
  onCancelQueued,
}: {
  msg: LocalMessage;
  onCancelQueued?: (msgId: string) => void;
}) {
  const failed = msg.status === "failed";
  const inProgress = msg.status === "in_progress";
  const queued = msg.status === "queued";
  const parts = msg.parts ?? [];

  const visibleParts = parts.filter((p) => {
    const t = typeof p?.type === "string" ? (p.type as string) : "";
    return (
      t === "text" ||
      t === "reasoning" ||
      t === "thinking" ||
      t === "tool" ||
      t === "image"
    );
  });

  return (
    <div className="flex flex-col gap-3">
      {failed && msg.text ? (
        <div
          className="sessions-md text-[14px] leading-relaxed"
          style={{ color: "#b91c1c" }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      ) : queued ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground leading-relaxed">
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
          queued — will send when current finishes
          {onCancelQueued && (
            <button
              type="button"
              onClick={() => onCancelQueued(msg.id)}
              title="Cancel queued message"
              className="ml-1 p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Cancel queued message"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ) : inProgress && visibleParts.length === 0 ? (
        msg.text ? (
          <div className="sessions-md text-[14px] text-foreground leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[14px] text-muted-foreground leading-relaxed">
            <Loader2 className="w-3 h-3 animate-spin" />
            thinking…
          </div>
        )
      ) : (
        visibleParts.map((p, i) => <PartBlock key={i} part={p} />)
      )}

      {failed && msg.error && (
        <div className="mono text-[11px] text-red-700">{msg.error}</div>
      )}

      {!inProgress && !failed && typeof msg.latency_ms === "number" && (
        <div className="mono text-[11px] text-muted-foreground">
          {formatLatency(msg.latency_ms)}
        </div>
      )}
    </div>
  );
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function PartBlock({ part }: { part: HarnessMessagePart }) {
  const t = typeof part?.type === "string" ? part.type : "";
  if (t === "text") {
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    if (!text) return null;
    return (
      <div className="sessions-md text-[14px] text-foreground leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (t === "reasoning" || t === "thinking") {
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    if (!text) return null;
    return <ReasoningBlock text={text} />;
  }
  if (t === "tool") {
    return <ToolBlock part={part} />;
  }
  return null;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 360 ? text.slice(0, 360) + "…" : text;
  return (
    <div className="border-l-2 border-border pl-3 text-[13px] text-muted-foreground italic leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-start gap-1 text-left hover:text-foreground"
      >
        <ChevronDown
          className={`w-3 h-3 mt-1 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="whitespace-pre-wrap">{open ? text : preview}</span>
      </button>
    </div>
  );
}

function toolDescriptor(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const n = tool.toLowerCase();
  if (n === "task") return pick("description");
  if (n === "bash") return pick("command", "description");
  if (n.includes("read") || n.includes("edit") || n.includes("write") || n.includes("patch"))
    return pick("filePath", "file_path", "path");
  if (n.includes("grep") || n.includes("glob") || n.includes("find"))
    return pick("pattern", "query");
  return "";
}

function ToolBlock({ part }: { part: HarnessMessagePart }) {
  const [open, setOpen] = useState(false);
  const p = part as Extract<HarnessMessagePart, { type: "tool" }>;
  const toolName = typeof p.tool === "string" ? p.tool : "tool";
  const state = (p.state as Record<string, unknown> | undefined) ?? {};
  const status = typeof state.status === "string" ? state.status : "running";
  const input = state.input;
  const output = state.output;
  const errorOut = state.error;
  const desc = toolDescriptor(toolName, input);

  const label = toolName;
  const hasDetails =
    input !== undefined || output !== undefined || errorOut !== undefined;

  const statusColor =
    status === "completed"
      ? "text-emerald-600"
      : status === "error"
        ? "text-red-600"
        : "text-amber-600";
  const StatusIcon =
    status === "completed" ? Check : status === "error" ? X : Loader2;

  return (
    <div className="border border-border rounded-md bg-muted/40 text-[13px] overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2 text-left min-w-0 ${
          hasDetails ? "hover:bg-muted cursor-pointer" : "cursor-default"
        }`}
      >
        <Wrench className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="mono text-foreground shrink-0">{label}</span>
        {desc && (
          <span className="mono text-muted-foreground truncate">{desc}</span>
        )}
        <StatusIcon
          className={`w-3 h-3 shrink-0 ${statusColor} ${status === "running" ? "animate-spin" : ""}`}
        />
        <span className={`mono text-[11px] shrink-0 ${statusColor}`}>
          {status}
        </span>
        {hasDetails && (
          <ChevronDown
            className={`ml-auto w-3 h-3 shrink-0 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>

      {open && hasDetails && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2">
          {input !== undefined && <ToolKv label="input" value={input} />}
          {output !== undefined && <ToolKv label="output" value={output} />}
          {errorOut !== undefined && <ToolKv label="error" value={errorOut} />}
        </div>
      )}
    </div>
  );
}

function ToolKv({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="flex flex-col gap-1">
      <span className="mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="mono text-[11px] text-foreground whitespace-pre-wrap break-words bg-background border border-border rounded p-2 max-h-64 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

export function MessageBlock({ msg }: { msg: HarnessMessage }) {
  const local = toLocal(msg);
  return <InnerMessageBlock msg={local} isFirstUser={false} />;
}
