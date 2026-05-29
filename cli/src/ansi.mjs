// ANSI escapes + terminal-drawing primitives shared across the CLI.

export const R      = "\x1b[0m";
export const BOLD   = "\x1b[1m";
export const DIM    = "\x1b[2m";
export const ITALIC = "\x1b[3m";
export const CYAN   = "\x1b[36m";
export const GREEN  = "\x1b[32m";
export const GRAY   = "\x1b[90m";
export const RED    = "\x1b[31m";
export const WHITE  = "\x1b[97m";
export const YELLOW = "\x1b[33m";
export const BLUE   = "\x1b[38;5;117m"; // lite accent (light blue)
export const ERASE  = "\r\x1b[K";       // move to col 0, erase line

export const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export const cols = () => process.stdout.columns || 80;
export const visibleLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
export const up = (n) => (n > 0 ? `\x1b[${n}A` : "");

// Rounded box that fills the terminal width. `lines` may contain ANSI codes;
// width is computed on the visible length so padding stays aligned.
export function drawBox(lines, { color = GRAY } = {}) {
  const w = cols() - 4;
  const top = `${color}╭${"─".repeat(w + 2)}╮${R}`;
  const bot = `${color}╰${"─".repeat(w + 2)}╯${R}`;
  const body = lines.map((line) => {
    const pad = " ".repeat(Math.max(0, w - visibleLen(line)));
    return `${color}│${R} ${line}${pad} ${color}│${R}`;
  });
  return ["", top, ...body, bot, ""].join("\n");
}
