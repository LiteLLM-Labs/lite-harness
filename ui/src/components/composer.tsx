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
    <div className="border-t border-border bg-background">
      <div className="max-w-3xl mx-auto px-4 py-3">
        <div className="relative">
          <div className="border rounded-xl shadow-sm bg-background overflow-hidden focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-all border-border">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={sending}
              rows={1}
              className="w-full p-4 outline-none resize-none text-[15px] placeholder:text-muted-foreground bg-transparent"
            />
            <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
              <span className="mono flex items-center gap-2">
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
                  className="bg-foreground text-background p-1.5 rounded-full hover:bg-foreground/90 transition-colors disabled:opacity-30 disabled:hover:bg-foreground"
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
