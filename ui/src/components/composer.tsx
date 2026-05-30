"use client";

import { useCallback, useState } from "react";
import { ArrowUp } from "lucide-react";
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const t = draft.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage({ sessionId, text: t, model });
      setDraft("");
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, sessionId, model, onSent]);

  // Plain Enter sends, Shift+Enter inserts a newline. Matches LAP.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const canSend = draft.trim().length > 0 && !sending;
  const placeholder = sending
    ? "Sending…"
    : "Add a follow up";

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur">
      <div className="mx-auto max-w-5xl px-6 py-4">
        <div className="relative">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={sending}
              rows={1}
              className="min-h-14 w-full resize-none bg-transparent px-4 pt-4 text-[15px] outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
              <span className="mono flex min-w-0 items-center gap-2 truncate">
                {error ? (
                  <span className="text-red-600">{error}</span>
                ) : (
                  model || "Enter to send · Shift+Enter for newline"
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  className="rounded-full bg-foreground p-1.5 text-background transition-colors hover:bg-foreground/90 disabled:opacity-30 disabled:hover:bg-foreground"
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
