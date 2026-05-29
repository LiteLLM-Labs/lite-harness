// `lite <harness>` — interactive TUI chat session.
// The composer owns a bottom-pinned input box; the conversation (this turn's
// echo, reasoning, tools, answer) is printed above it via composer.print.

import { R, BOLD, DIM, CYAN, GREEN, GRAY, RED, WHITE, BLUE, drawBox } from "../ansi.mjs";
import { loadConfig } from "../config.mjs";
import { LiteClient } from "../client.mjs";
import { makeRenderer } from "../renderer.mjs";
import { createComposer } from "../composer.mjs";
import { sessionPicker } from "../session-picker.mjs";

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

  // ── Event handling ──────────────────────────────────────────────────────────
  const abort = new AbortController();
  const partWritten = new Map();
  const assistantMsgIds = new Set(); // only render parts for assistant messages
  let idleResolve = null;

  function resetTurn() { partWritten.clear(); assistantMsgIds.clear(); }

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

  client.streamEvents((ev) => {
    const evSid = ev?.properties?.sessionID ?? ev?.properties?.info?.sessionID;
    if (evSid === currentSid) handleEvent(ev);
  }, abort.signal);

  // ── Turn ──────────────────────────────────────────────────────────────────────
  async function sendAndWait(text) {
    const done = new Promise((resolve) => { idleResolve = resolve; });
    renderer.startSpinner();
    try {
      await client.prompt(currentSid, model, text);
      const timeout = new Promise((resolve) => setTimeout(resolve, 600_000));
      await Promise.race([done, timeout]);
    } catch (e) {
      renderer.error(e.message);
    } finally {
      idleResolve = null;
    }
  }

  async function clearSession() {
    await client.deleteSession(currentSid);
    const s = await client.createSession(harnessName);
    currentSid = s.id;
    resetTurn();
    idleResolve = null;
    composer.clearConversation();
  }

  function printHelp() {
    composer.print([
      "",
      `  ${BOLD}${WHITE}Slash commands${R}`,
      `  ${CYAN}/clear${R}    ${GRAY}reset session history${R}`,
      `  ${CYAN}/resume${R}   ${GRAY}pick a previous session to continue${R}`,
      `  ${CYAN}/help${R}     ${GRAY}show this command list${R}`,
      `  ${CYAN}exit${R}      ${GRAY}quit lite-harness${R}`,
      "",
    ].join("\n") + "\n");
  }

  async function resume() {
    let sessions;
    try { sessions = await client.listSessions(harnessName); }
    catch (e) { composer.print(`  ${RED}✗ ${e.message}${R}\n`); return; }
    if (!sessions.length) { composer.print(`  ${GRAY}No sessions found.${R}\n`); return; }
    sessions.sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0));

    composer.suspend();              // hand the screen to the full-screen picker
    const picked = await sessionPicker(sessions);
    composer.resume();               // re-pin the box
    if (!picked) return;

    currentSid = picked.id;
    resetTurn();
    idleResolve = null;
    composer.print(`  ${GREEN}✓ Resumed${R}  ${GRAY}${picked.title || picked.id}  ${picked.id.slice(0, 14)}${R}\n\n`);
    try {
      const msgs = await client.listMessages(currentSid);
      for (const msg of msgs) {
        const role = msg.info?.role;
        if (role === "user") {
          const t = msg.parts?.find((p) => p.type === "text")?.text ?? "";
          if (t) composer.print(`  ${BLUE}❯${R} ${t}\n`);
        } else if (role === "assistant") {
          for (const part of msg.parts ?? []) {
            if (part.type === "text" && part.text) renderer.text(part.text);
            else if (part.type === "tool" && part.tool) renderer.tool(part.tool, part.state);
          }
          renderer.finish();
        }
      }
    } catch (e) {
      composer.print(`  ${GRAY}(could not load history: ${e.message})${R}\n`);
    }
  }

  function quit() { composer.stop(); abort.abort(); process.exit(0); }

  // ── Composer (owns the pinned box + stdin) ───────────────────────────────────
  const composer = createComposer({
    onQuit: quit,
    onInterrupt: () => {
      renderer.finish();
      composer.print(`  ${GRAY}interrupted${R}\n`);
      idleResolve?.(); idleResolve = null;
    },
    onSubmit: async (raw) => {
      const text = raw.trim();
      if (text) {
        if (text === "exit" || text === "quit" || text === "\\q") return quit();
        if (text === "/" || text === "/help") printHelp();
        else if (text === "/clear") { try { await clearSession(); } catch (e) { composer.print(`  ${RED}✗ ${e.message}${R}\n`); } }
        else if (text === "/resume") await resume();
        else await sendAndWait(text);
      }
      composer.idle(); // re-focus the box for the next message
    },
  });

  const renderer = makeRenderer(composer.print);

  composer.start();
  composer.print(drawBox([
    `${BLUE}✻${R} ${BOLD}${WHITE}Welcome to lite-harness${R}`,
    "",
    `${GRAY}harness${R}   ${CYAN}${harnessName}${R}`,
    `${GRAY}model${R}     ${model}`,
    `${GRAY}server${R}    ${client.shortUrl}`,
    `${GRAY}session${R}   ${currentSid.slice(0, 16)}`,
    "",
    `${DIM}/help for commands  ·  /resume to switch session  ·  Esc to interrupt  ·  Ctrl+C to quit${R}`,
  ], { color: BLUE }));
  composer.idle();

  await new Promise(() => {}); // composer drives everything via events
}
