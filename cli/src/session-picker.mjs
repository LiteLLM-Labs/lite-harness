// Interactive arrow-key session picker. Returns the selected session object,
// or null if the user cancels with Esc / Ctrl+C.

import { R, BOLD, DIM, CYAN, GRAY, GREEN, WHITE, up, cols } from "./ansi.mjs";

const MAX_ROWS = 12;

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function sessionPicker(sessions) {
  if (!sessions.length) return Promise.resolve(null);

  const items = sessions.slice(0, MAX_ROWS);
  let sel = 0;

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = (s) => process.stdout.write(s);

    const w = cols() - 4;
    let rendered = 0;

    function render() {
      if (rendered > 0) {
        out(up(rendered));
        out("\x1b[0J"); // erase from cursor to end of screen
      }
      const lines = [];
      lines.push(`  ${BOLD}${WHITE}Sessions${R}  ${DIM}↑↓ select  ·  Enter open  ·  Esc cancel${R}`);
      lines.push("");
      for (let i = 0; i < items.length; i++) {
        const s = items[i];
        const cursor = i === sel ? `${GREEN}▶${R}` : " ";
        const title = (s.title || s.id).slice(0, 40).padEnd(40);
        const sid   = s.id.slice(0, 14);
        const age   = relativeTime(s.time?.updated ?? s.time?.created);
        const titleColored = i === sel ? `${CYAN}${title}${R}` : title;
        lines.push(`  ${cursor} ${titleColored}  ${GRAY}${sid}  ${age}${R}`);
      }
      lines.push("");
      out(lines.join("\n"));
      // join("\n") with trailing "" emits lines.length-1 actual newlines → that's the cursor displacement
      rendered = lines.length - 1;
    }

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(chunk) {
      const s = chunk.toString("utf8");

      if (s === "\x1b[A" || s === "\x1bOA") { sel = Math.max(0, sel - 1); render(); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { sel = Math.min(items.length - 1, sel + 1); render(); return; }

      if (s === "\r" || s === "\n") {
        cleanup();
        out("\n");
        resolve(items[sel]);
        return;
      }

      if (s === "\x1b" || s === "\x04") {
        cleanup();
        out("\n");
        resolve(null);
        return;
      }
      if (s === "\x03") { cleanup(); process.stdout.write("\n"); process.exit(0); }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    rendered = 0;
    render();
  });
}
