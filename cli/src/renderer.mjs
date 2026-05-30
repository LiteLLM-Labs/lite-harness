// Streaming output renderer. Renders the assistant turn the way Claude Code
// does: a dim "Thinking…" block for reasoning, "● tool(args)" lines with an
// indented "⎿" result, and the final answer as a bulleted block.

import {
  R, BOLD, DIM, ITALIC, GREEN, GRAY, RED, YELLOW, BLUE, ERASE,
  SPINNER_FRAMES, cols,
} from "./ansi.mjs";

export function makeRenderer() {
  const out = (s) => process.stdout.write(s);

  let spinnerTimer = null;
  let spinnerFrame = 0;
  let block = null;       // null | "text" | "reasoning"
  let atLineStart = true; // are we at the start of a fresh line?

  function startSpinner() {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      out(`${ERASE}  ${BLUE}${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]}${R} ${GRAY}working…${R}`);
    }, 80);
  }
  function stopSpinner() {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; out(ERASE); }
  }

  // Stream `text`, prefixing every fresh line with `prefix` (margin + color).
  // Splits on newlines rather than iterating char-by-char to reduce syscall count.
  function feed(text, prefix) {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) { out(R + "\n"); atLineStart = true; }
      const seg = parts[i];
      if (seg) {
        if (atLineStart) { out(prefix); atLineStart = false; }
        out(seg);
      }
    }
  }

  function closeBlock() {
    if (block && !atLineStart) { out(R); out("\n"); }
    block = null;
    atLineStart = true;
  }

  function text(delta) {
    stopSpinner();
    if (block !== "text") {
      closeBlock();
      out(`\n  ${BLUE}●${R} `);
      atLineStart = false;
      block = "text";
    }
    feed(delta, "    ");
  }

  function reasoning(delta) {
    stopSpinner();
    if (block !== "reasoning") {
      closeBlock();
      out(`\n  ${DIM}${ITALIC}✻ Thinking…${R}\n`);
      atLineStart = true;
      block = "reasoning";
    }
    feed(delta, `    ${DIM}${ITALIC}`);
  }

  function tool(toolName, state) {
    stopSpinner();
    closeBlock();
    const status = state?.status ?? "running";
    const dot = status === "completed" ? GREEN : status === "error" ? RED : YELLOW;
    let args = "";
    if (state?.input) {
      const s = typeof state.input === "string" ? state.input : JSON.stringify(state.input);
      args = ` ${GRAY}${s.length > 80 ? s.slice(0, 79) + "…" : s}${R}`;
    }
    out(`\n  ${dot}●${R} ${BOLD}${toolName}${R}${args}\n`);
    if ((status === "completed" || status === "error") && (state?.output || state?.error)) {
      const raw = state.error ?? state.output;
      const str = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
      const lines = str.split("\n");
      lines.slice(0, 6).forEach((l, i) => {
        const branch = i === 0 ? "⎿ " : "  ";
        out(`    ${GRAY}${branch}${l.slice(0, cols() - 8)}${R}\n`);
      });
      if (lines.length > 6) out(`    ${GRAY}  … +${lines.length - 6} lines${R}\n`);
    }
    atLineStart = true;
  }

  function finish() {
    stopSpinner();
    closeBlock();
  }

  function error(msg) {
    stopSpinner();
    closeBlock();
    out(`\n  ${RED}● Error${R}  ${GRAY}${msg}${R}\n`);
    atLineStart = true;
  }

  return { startSpinner, stopSpinner, text, reasoning, tool, finish, error };
}
