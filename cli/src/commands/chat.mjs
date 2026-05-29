// `lite <harness>` — interactive TUI chat session.
// Wires the client (server I/O), renderer (output), and boxedPrompt (input)
// into a prompt → stream → prompt loop.

import { R, BOLD, DIM, CYAN, GREEN, GRAY, RED, WHITE, BLUE, drawBox } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";
import { makeRenderer } from "../renderer.mjs";
import { boxedPrompt, EXIT } from "../input.mjs";
import { sessionPicker } from "../session-picker.mjs";
import { SLASH_COMMANDS } from "../slash-commands.mjs";

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
    `${DIM}/help for commands  ·  /resume to switch session  ·  Esc to interrupt  ·  Ctrl+C to quit${R}`,
  ], { color: BLUE }));

  // ── Event handling ────────────────────────────────────────────────────────────
  const abort = new AbortController();
  const renderer = makeRenderer();
  const partWritten = new Map();
  const assistantMsgIds = new Set(); // only render parts for assistant messages
  let idleResolve = null;
  let interrupted = false;

  function handleEvent(ev) {
    if (interrupted) return;
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
    interrupted = false;
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
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor to top
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
          interrupted = true;
          renderer.finish();
          process.stdout.write(`  ${GRAY}interrupted${R}\n`);
          client.abort(currentSid);
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

    if (text === "/" || text === "/help") {
      const sig = (c) => (c.args ? `${c.name} ${c.args}` : c.name);
      const w = Math.max(...SLASH_COMMANDS.map((c) => sig(c).length), "exit".length);
      const rows = SLASH_COMMANDS.map(
        (c) => `  ${CYAN}${sig(c).padEnd(w)}${R}   ${GRAY}${c.hint}${R}`
      );
      process.stdout.write([
        "",
        `  ${BOLD}${WHITE}Slash commands${R}`,
        ...rows,
        `  ${CYAN}${"exit".padEnd(w)}${R}   ${GRAY}quit lite-harness${R}`,
        "",
      ].join("\n"));
      continue;
    }

    if (text === "/clear") {
      try { await clearSession(); } catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n`); }
      process.stdout.write("\n");
      continue;
    }

    if (text === "/resume") {
      let sessions;
      try { sessions = await client.listSessions(harnessName); }
      catch (e) { process.stdout.write(`  ${RED}✗ ${e.message}${R}\n\n`); continue; }
      if (!sessions.length) { process.stdout.write(`  ${GRAY}No sessions found.${R}\n\n`); continue; }
      // Sort newest first
      sessions.sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0));
      const picked = await sessionPicker(sessions);
      if (picked) {
        currentSid = picked.id;
        resetTurn();
        idleResolve = null;
        process.stdout.write(`\n  ${GREEN}✓ Resumed${R}  ${GRAY}${picked.title || picked.id}  ${picked.id.slice(0, 14)}${R}\n\n`);
        try {
          const msgs = await client.listMessages(currentSid);
          for (const msg of msgs) {
            const role = msg.info?.role;
            if (role === "user") {
              const text = msg.parts?.find(p => p.type === "text")?.text ?? "";
              if (text) process.stdout.write(`  ${BLUE}❯${R} ${text}\n\n`);
            } else if (role === "assistant") {
              for (const part of msg.parts ?? []) {
                if (part.type === "text" && part.text) {
                  renderer.text(part.text);
                } else if (part.type === "tool" && part.tool) {
                  renderer.tool(part.tool, part.state);
                }
              }
              renderer.finish();
              process.stdout.write("\n");
            }
          }
        } catch (e) {
          process.stdout.write(`  ${GRAY}(could not load history: ${e.message})${R}\n\n`);
        }
      }
      continue;
    }

    await sendAndWait(text);
    process.stdout.write("\n");
  }
}
