// `lite <harness>` — interactive TUI chat session.
// Wires the client (server I/O), renderer (output), and boxedPrompt (input)
// into a prompt → stream → prompt loop.

import { R, BOLD, DIM, CYAN, GREEN, GRAY, RED, WHITE, BLUE, drawBox } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";
import { makeRenderer } from "../renderer.mjs";
import { boxedPrompt, EXIT } from "../input.mjs";

export async function chat(harnessName, flags) {
  const config = loadConfig();
  if (!config) {
    console.error(`${RED}Not logged in. Run: lite login${R}`);
    process.exit(1);
  }

  const client = new LiteClient(config);
  const model = flags.model || (await client.firstModel()) || "gpt-4o";

  let session;
  try {
    session = await client.createSession(harnessName);
  } catch (e) {
    console.error(`${RED}Failed to create session: ${e.message}${R}`);
    process.exit(1);
  }
  let currentSid = session.id;

  // ── Welcome box ─────────────────────────────────────────────────────────────
  process.stdout.write(drawBox([
    `${BLUE}✻${R} ${BOLD}${WHITE}Welcome to lite-harness${R}`,
    "",
    `${GRAY}harness${R}   ${CYAN}${harnessName}${R}`,
    `${GRAY}model${R}     ${model}`,
    `${GRAY}server${R}    ${client.shortUrl}`,
    `${GRAY}session${R}   ${currentSid.slice(0, 16)}`,
    "",
    `${DIM}/clear to reset history  ·  Esc to interrupt  ·  Ctrl+C to quit${R}`,
  ], { color: BLUE }));

  // ── Event handling ────────────────────────────────────────────────────────────
  const abort = new AbortController();
  const renderer = makeRenderer();
  const partWritten = new Map();
  const assistantMsgIds = new Set(); // only render parts for assistant messages
  let idleResolve = null;

  function handleEvent(ev) {
    if (ev.type === "message.updated") {
      const info = ev.properties?.info;
      if (info?.id && info?.role === "assistant") assistantMsgIds.add(info.id);
    } else if (ev.type === "message.part.delta") {
      const { field, delta, partID, messageID } = ev.properties ?? {};
      if (!delta || !assistantMsgIds.has(messageID)) return;
      if (field === "text") renderer.text(delta);
      else if (field === "reasoning") renderer.reasoning(delta);
      else return;
      partWritten.set(partID, (partWritten.get(partID) ?? 0) + delta.length);
    } else if (ev.type === "message.part.updated") {
      const part = ev.properties?.part;
      if (!part?.id || !assistantMsgIds.has(part.messageID)) return;
      if ((part.type === "text" || part.type === "reasoning" || part.type === "thinking") && part.text) {
        const written = partWritten.get(part.id) ?? 0;
        const tail = part.text.slice(written);
        if (tail) {
          if (part.type === "text") renderer.text(tail);
          else renderer.reasoning(tail);
          partWritten.set(part.id, part.text.length);
        }
      } else if (part.type === "tool" && part.tool) {
        renderer.tool(part.tool, part.state);
        partWritten.set(part.id, 1); // mark rendered
      }
    } else if (ev.type === "session.idle") {
      renderer.finish();
      resetTurn();
      idleResolve?.(); idleResolve = null;
    } else if (ev.type === "session.error") {
      const errObj = ev.properties?.error;
      const msg = errObj?.data?.message ?? errObj?.message ?? JSON.stringify(errObj ?? ev.properties);
      renderer.error(msg);
      partWritten.clear();
      idleResolve?.(); idleResolve = null;
    }
  }

  function resetTurn() {
    partWritten.clear();
    assistantMsgIds.clear();
  }

  client.streamEvents((ev) => {
    const evSid = ev?.properties?.sessionID ?? ev?.properties?.info?.sessionID;
    if (evSid === currentSid) handleEvent(ev);
  }, abort.signal);

  // ── Actions ───────────────────────────────────────────────────────────────────
  async function clearSession() {
    await client.deleteSession(currentSid);
    const s = await client.createSession(harnessName);
    currentSid = s.id;
    resetTurn();
    idleResolve = null;
    process.stdout.write(`\n  ${GREEN}✓ Session cleared${R}  ${GRAY}${currentSid.slice(0, 12)}${R}\n`);
  }

  function quit() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    abort.abort();
    process.stdout.write("\n");
    process.exit(0);
  }

  async function sendAndWait(text) {
    const done = new Promise((resolve) => { idleResolve = resolve; });
    renderer.startSpinner();

    // While streaming, watch for Esc (interrupt) / Ctrl+C (quit).
    let onKey = null;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      onKey = (d) => {
        const k = d.toString("utf8");
        if (k.includes("\x03")) quit();          // Ctrl+C
        else if (k === "\x1b") {                  // bare Esc → interrupt
          renderer.finish();
          process.stdout.write(`  ${GRAY}interrupted${R}\n`);
          idleResolve?.(); idleResolve = null;
        }
      };
      process.stdin.on("data", onKey);
    }

    try {
      await client.prompt(currentSid, model, text);
      const timeout = new Promise((resolve) => setTimeout(resolve, 600_000));
      await Promise.race([done, timeout]);
    } catch (e) {
      renderer.error(e.message);
    } finally {
      idleResolve = null;
      if (onKey) {
        process.stdin.removeListener("data", onKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      }
    }
  }

  // ── Input loop ──────────────────────────────────────────────────────────────
  const history = [];

  while (true) {
    const input = await boxedPrompt(history);
    if (input === EXIT) quit();
    const text = input.trim();
    if (!text) continue;
    if (text === "exit" || text === "quit" || text === "\\q") quit();

    history.push(text);
    // In a TTY the submitted box stays on screen as scrollback; only the
    // non-TTY (piped) path needs the prompt echoed back.
    if (!process.stdin.isTTY) process.stdout.write(`  ${BLUE}❯${R} ${text}\n`);

    if (text === "/clear") {
      try { await clearSession(); } catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n`); }
      process.stdout.write("\n");
      continue;
    }

    await sendAndWait(text);
    process.stdout.write("\n");
  }
}
