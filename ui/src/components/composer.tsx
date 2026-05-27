"use client";

import { useState, type KeyboardEvent } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { sendMessage } from "@/lib/api";

export function Composer({
  sessionId,
  model,
  onSent,
}: {
  sessionId: string;
  model: string;
  onSent?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage({ sessionId, text: t, model });
      setText("");
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-border bg-background">
      <div className="max-w-3xl mx-auto px-4 py-3">
        <div className={cn("flex items-end gap-2")}>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Send a message…  (Cmd/Ctrl+Enter to send)"
            rows={3}
            disabled={sending}
            className="flex-1 resize-none"
          />
          <Button onClick={submit} disabled={sending || !text.trim()}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        {error && (
          <div className="text-xs text-destructive mt-2">{error}</div>
        )}
      </div>
    </div>
  );
}
