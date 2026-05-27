#!/usr/bin/env node
/*
 * opencode inline adapter — makes attached skills LOADABLE on the single shared
 * `opencode serve` (the opencode-brain-inline harness).
 *
 * Why an adapter at all: opencode discovers skills from disk at session-create
 * time, and the platform delivers an agent's skills as SandboxFileSpec entries
 * in the POST /session `files` array. opencode *does* write that array, but only
 * after the session is created — too late for the new session to discover them.
 * So this adapter writes the skill files to the shared global skills dir
 * (~/.claude/skills) BEFORE forwarding session-create, so opencode picks them up
 * for that turn.
 *
 * Skills are written to the shared dir (not a per-agent directory): on this
 * shared server every agent sees every attached skill. We deliberately do NOT
 * pin sessions to a per-agent `?directory` — opencode's `/event` bus is
 * directory-scoped, and the UI's `/event` subscription has no directory, so a
 * per-session directory would hide the live transcript (the chat would hang on
 * "thinking…" even though the turn completed).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");

// Per-session harness tag. opencode sessions exist in the child's DB;
// cc sessions live entirely in-process.
const sessionHarness = new Map(); // id → "opencode" | "cc"

const log = (...a) => console.log("[inline-adapter]", ...a);

// Load the claude-code SDK from its own node_modules (sibling harness dir).
const _require = createRequire(import.meta.url);
let ccQuery;
try {
  const sdkPath = _require.resolve(
    "../claude-code/node_modules/@anthropic-ai/claude-code/sdk.mjs",
  );
  const mod = await import(sdkPath);
  ccQuery = mod.query;
  log("claude-code SDK loaded");
} catch (e) {
  log(`claude-code SDK not available: ${e.message}`);
}

// In-process state for claude-code sessions.
const ccSessions = new Map(); // id → {id, title, time, sdkSessionId, history, busSubscribers}
const ccGlobalBus = new Set(); // SSE response writers for cc events

function ccEmit(sessionId, type, props) {
  const ev = { id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type, properties: { ...props, sessionID: sessionId } };
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  const s = ccSessions.get(sessionId);
  if (s) for (const cb of s.busSubscribers) { try { cb(line); } catch {} }
  for (const cb of ccGlobalBus) { try { cb(line); } catch {} }
}

function ccHandleSdkEvent(sessionId, m, parts, msgId, turn, sink) {
  const ev = m;
  if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
    sink({ sdk_session_id: ev.session_id });
  } else if (ev.type === "assistant" && ev.message) {
    const content = ev.message.content ?? [];
    const sdkMsgId = ev.message.id;
    const seenBlocks = turn.asstBlockCount.get(sdkMsgId ?? "") ?? 0;
    content.forEach((block, idx) => {
      const blockIdx = seenBlocks + idx;
      const partId = `${sdkMsgId ?? msgId}_b${blockIdx}`;
      if (block.type === "text") {
        const part = { id: partId, messageID: msgId, type: "text", text: block.text ?? "" };
        parts.push(part);
        ccEmit(sessionId, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "thinking") {
        const thinkingKey = `${sdkMsgId}:${blockIdx}`;
        const streamAccum = turn.thinkingAccum.get(thinkingKey) ?? "";
        const part = { id: partId, messageID: msgId, type: "reasoning", text: block.thinking || streamAccum };
        parts.push(part);
        ccEmit(sessionId, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "tool_use") {
        const part = { id: partId, messageID: msgId, type: "tool", tool: block.name, callID: block.id, state: { input: block.input, status: "running" } };
        parts.push(part);
        ccEmit(sessionId, "message.part.updated", { messageID: msgId, part });
      }
    });
    turn.asstBlockCount.set(sdkMsgId ?? "", seenBlocks + content.length);
  } else if (ev.type === "user" && ev.message) {
    for (const block of (ev.message.content ?? [])) {
      if (block.type !== "tool_result") continue;
      const matching = parts.filter(p => p.type === "tool").find(p => p.callID === block.tool_use_id);
      if (!matching) continue;
      const out = Array.isArray(block.content) ? block.content.map(c => c.type === "text" ? (c.text ?? "") : "").join("") : typeof block.content === "string" ? block.content : "";
      matching.state.status = block.is_error ? "error" : "completed";
      matching.state.output = out;
      ccEmit(sessionId, "message.part.updated", { messageID: msgId, part: matching });
    }
  } else if (ev.type === "result") {
    sink({ cost: ev.total_cost_usd, usage: { input: ev.usage?.input_tokens, output: ev.usage?.output_tokens, cache: { read: ev.usage?.cache_read_input_tokens, write: ev.usage?.cache_creation_input_tokens } } });
    if (ev.is_error) sink({ error: { name: "ResultError", data: { message: String(ev.result ?? "agent error") } } });
  } else if (ev.type === "stream_event") {
    const inner = ev.event;
    if (inner?.type === "message_start" && inner.message?.id) {
      turn.currentSdkMsgId = inner.message.id;
      turn.blockIdxsBySdkMsgId.set(inner.message.id, []);
    } else if (inner?.type === "content_block_start" && typeof inner.index === "number" && turn.currentSdkMsgId) {
      const arr = turn.blockIdxsBySdkMsgId.get(turn.currentSdkMsgId) ?? [];
      arr[inner.index] = turn.nextGlobalIdx++;
      turn.blockIdxsBySdkMsgId.set(turn.currentSdkMsgId, arr);
      // Emit initial empty part so UI creates the slot before deltas arrive.
      // Without this, delta events arrive before the part exists in UI state
      // and are silently dropped by the findIndex(-1) guard.
      const blockType = inner.content_block?.type;
      if (blockType === "text" || blockType === "thinking") {
        const partID = `${turn.currentSdkMsgId}_b${inner.index}`;
        ccEmit(sessionId, "message.part.updated", {
          messageID: msgId,
          part: { id: partID, messageID: msgId, type: blockType === "thinking" ? "reasoning" : "text", text: "" },
        });
      }
    } else if (inner?.type === "content_block_delta" && typeof inner.index === "number" && turn.currentSdkMsgId) {
      const partID = `${turn.currentSdkMsgId}_b${inner.index}`;
      if (inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
        ccEmit(sessionId, "message.part.delta", { messageID: msgId, partID, field: "text", delta: inner.delta.text });
      } else if (inner.delta?.type === "thinking_delta" && typeof inner.delta.thinking === "string") {
        const key = `${turn.currentSdkMsgId}:${inner.index}`;
        turn.thinkingAccum.set(key, (turn.thinkingAccum.get(key) ?? "") + inner.delta.thinking);
        ccEmit(sessionId, "message.part.delta", { messageID: msgId, partID, field: "reasoning", delta: inner.delta.thinking });
      }
    }
  }
}

async function ccRunTurn(s, userText, modelId) {
  if (!ccQuery) throw new Error("claude-code SDK not loaded");
  const startedAt = Date.now();
  const ac = new AbortController();
  s.abortController = ac;

  const userMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const userPart = { id: `${userMsgId}_p0`, messageID: userMsgId, type: "text", text: userText };
  const userMsg = { info: { id: userMsgId, role: "user", time: { created: startedAt, completed: startedAt } }, parts: [userPart] };
  s.history.push(userMsg);
  ccEmit(s.id, "message.updated", { info: userMsg.info });
  ccEmit(s.id, "message.part.updated", { messageID: userMsgId, part: userPart });

  const asstMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const parts = [];
  let lastError, totalCost, usage;
  const turn = { nextGlobalIdx: 0, currentSdkMsgId: null, blockIdxsBySdkMsgId: new Map(), thinkingAccum: new Map(), asstBlockCount: new Map() };

  ccEmit(s.id, "message.updated", { info: { id: asstMsgId, role: "assistant", time: { created: startedAt } } });

  try {
    const stream = ccQuery({ prompt: userText, options: {
      model: modelId,
      cwd: process.env.CC_REPO_DIR ?? process.env.HOME ?? "/tmp",
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      abortController: ac,
      disallowedTools: ["AskUserQuestion"],
      ...(s.sdkSessionId ? { resume: s.sdkSessionId } : {}),
    }});
    for await (const m of stream) {
      if (m.type === "system" && m.subtype === "init" && m.session_id && !s.sdkSessionId) s.sdkSessionId = m.session_id;
      ccHandleSdkEvent(s.id, m, parts, asstMsgId, turn, (e) => {
        if (e.error) lastError = e.error;
        if (e.cost !== undefined) totalCost = e.cost;
        if (e.usage) usage = e.usage;
        if (e.sdk_session_id && !s.sdkSessionId) s.sdkSessionId = e.sdk_session_id;
      });
    }
  } catch (err) {
    if (ac.signal.aborted) {
      lastError = { name: "AbortError", data: { message: "aborted" } };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      if (s.sdkSessionId && msg.includes("Blocked")) {
        log(`cc stale session retry id=${s.id}`);
        s.sdkSessionId = null;
        s.history.pop();
        s.abortController = null;
        return ccRunTurn(s, userText, modelId);
      }
      lastError = { name: "SDKError", data: { message: msg.slice(0, 500) } };
    }
  } finally { s.abortController = null; }

  const completedAt = Date.now();
  const fullInfo = { id: asstMsgId, role: "assistant", time: { created: startedAt, completed: completedAt }, tokens: usage, cost: totalCost, ...(lastError ? { error: lastError } : { finish: "stop" }) };
  s.history.push({ info: fullInfo, parts });
  s.time.updated = completedAt;
  ccEmit(s.id, "message.updated", { info: fullInfo });
  ccEmit(s.id, "session.idle", {});
  log(`cc turn done id=${s.id} parts=${parts.length}`);
}

// Static UI bundle (Next.js export). Built via `cd ui && npm run build`.
// Served at any GET path that resolves to a real file on disk under UI_DIST,
// so the browser hits the same port as the harness API (single deployment).
const UI_DIST = path.resolve(
  process.env.UI_DIST ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "ui", "out"),
);
const UI_DIST_EXISTS = fs.existsSync(UI_DIST);
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve a static asset from UI_DIST. Returns true if a file was served (so
 * the caller stops), false if no file matched — letting the caller fall
 * through to the harness-API handlers below.
 */
function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  const candidates = [rel];
  if (!path.extname(rel)) {
    candidates.push(path.join(rel, "index.html"));
    candidates.push(rel + ".html");
  }
  for (const candidate of candidates) {
    const abs = path.resolve(UI_DIST, candidate);
    if (!abs.startsWith(UI_DIST + path.sep) && abs !== UI_DIST) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const ext = path.extname(abs).toLowerCase();
    const ctype = MIME_BY_EXT[ext] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": ctype,
      "content-length": stat.size,
      "cache-control": rel.startsWith("_next/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  }
  return false;
}
const DRAIN_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;
const HEALTH_INTERVAL_MS = 30_000;
const MSG_TAIL_CHARS = 200; // how many chars of message content to log

// Lifecycle state
let draining = false;       // true once SIGTERM received
let inFlight = 0;           // count of requests currently being handled
let restartCount = 0;       // how many times we've restarted the child
let currentChild = null;    // reference to the active child process

function checkDrainComplete() {
  if (draining && inFlight === 0) {
    log("drain complete — exiting");
    process.exit(0);
  }
}

// Probe the child and return true if it responds to any HTTP request.
function probeChild() {
  return new Promise((resolve) => {
    const req = http.get(UP + "/", { timeout: 2000 }, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode ?? 0) > 0, status: res.statusCode });
    });
    req.on("error", (e) => resolve({ ok: false, err: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, err: "timeout" }); });
  });
}
// A SandboxFileSpec is a skill file when its sandbox_path lands in a skills dir
// and is a SKILL.md. Returns the slug (the directory under skills/), else null.
// Leading-alnum anchor rejects "." / ".." so a crafted name can't escape the dir.
function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9][a-z0-9._-]*$/i.test(m[1]) ? m[1] : null;
}

// Write a session's skill files to the shared global skills dir so opencode
// discovers them when it creates the session. Returns how many were written.
function materializeSkills(files) {
  let written = 0;
  for (const f of files || []) {
    const slug = skillSlug(f.sandbox_path);
    if (!slug) continue;
    const dir = path.join(SKILLS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), Buffer.from(f.content || "", "base64"));
    written++;
  }
  return written;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

// Extract the tail of the last text part from a message body for logging.
function extractMsgTail(rawBody) {
  try {
    const body = JSON.parse(rawBody || "{}");
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const textParts = parts.filter((p) => p && p.type === "text" && typeof p.text === "string");
    if (textParts.length === 0) return null;
    const last = textParts[textParts.length - 1].text;
    return last.length > MSG_TAIL_CHARS ? "…" + last.slice(-MSG_TAIL_CHARS) : last;
  } catch {
    return null;
  }
}

function forward(method, urlPath, search, bodyBuf, clientRes, label) {
  const t0 = Date.now();
  const dest = UP + urlPath + (search || "");
  const upReq = http.request(dest, { method, headers: { "content-type": "application/json" } }, (upRes) => {
    const elapsed = Date.now() - t0;
    log(`← ${upRes.statusCode} ${method} ${urlPath} (${elapsed}ms)`);
    if (upRes.statusCode >= 400) {
      // Collect and log error body so we can see what opencode said
      let errBody = "";
      upRes.on("data", (c) => { errBody += c; });
      upRes.on("end", () => {
        log(`child error body for ${label || urlPath}: ${errBody.slice(0, 300)}`);
      });
    }
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
  });
  upReq.on("error", (e) => {
    const elapsed = Date.now() - t0;
    log(`forward error ${e.code || e.message} on ${method} ${urlPath} (${elapsed}ms)`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: String(e) }));
    }
  });
  if (bodyBuf) upReq.write(bodyBuf);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // JSON status probe (used by LAP/k8s readiness). Must come BEFORE the
  // static handler so a stray `health.html` could never shadow it.
  if (p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true, draining, inFlight, restartCount, ui: UI_DIST_EXISTS }));
    return;
  }

  // Same-origin UI bundle: serve the static export at GET paths that resolve
  // to a real file under UI_DIST. The harness API routes (POST /session,
  // GET /event, ...) never resolve to a file on disk, so they fall through.
  if (req.method === "GET" && UI_DIST_EXISTS && serveStatic(p, res)) return;

  // Reject NEW session creates while draining; all other in-flight paths continue.
  if (draining && p === "/session" && req.method === "POST") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server is draining — no new sessions accepted" }));
    return;
  }

  // Log every incoming request with path + Content-Length
  const contentLength = req.headers["content-length"] || "?";
  log(`→ ${req.method} ${p} (${contentLength} bytes)`);

  inFlight++;
  let decremented = false;
  const decrement = () => { if (!decremented) { decremented = true; inFlight--; checkDrainComplete(); } };
  res.on("finish", decrement);
  res.on("close", decrement);

  // POST /session: materialize this agent's skills before opencode creates the
  // session, then forward unchanged (no ?directory — keep the /event bus global).
  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}

    const harness = body.harness === "claude-code" ? "cc" : "opencode";

    if (harness === "cc") {
      if (!ccQuery) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "claude-code SDK not available" }));
        return;
      }
      const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const now = Date.now();
      const s = { id, title: body.title || "New session", time: { created: now }, harness: "claude-code", sdkSessionId: null, abortController: null, history: [], busSubscribers: new Set() };
      ccSessions.set(id, s);
      sessionHarness.set(id, "cc");
      log(`cc session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, harness: "claude-code" }));
      return;
    }

    // opencode session
    const n = materializeSkills(body.files);
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s) title=${JSON.stringify(body.title || "")}`);
    // Strip harness field before forwarding to opencode child
    const { harness: _h, ...forwardBody } = body;
    // Capture the response to record the session id in our registry
    const upReq = http.request(UP + "/session", { method: "POST", headers: { "content-type": "application/json" } }, (upRes) => {
      let respData = "";
      upRes.on("data", c => respData += c);
      upRes.on("end", () => {
        try {
          const parsed = JSON.parse(respData);
          if (parsed.id) sessionHarness.set(parsed.id, "opencode");
        } catch {}
        res.writeHead(upRes.statusCode || 200, upRes.headers);
        res.end(respData);
      });
    });
    upReq.on("error", (e) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); } });
    upReq.end(JSON.stringify(forwardBody));
    return;
  }

  // GET /session — merge opencode sessions + in-process cc sessions
  if (p === "/session" && req.method === "GET") {
    const ocFetch = () => new Promise((resolve) => {
      const rq = http.get(UP + "/session", (r) => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => {
          try { resolve(JSON.parse(d)); } catch { resolve([]); }
        });
      });
      rq.on("error", () => resolve([]));
    });
    const ocSessions = await ocFetch();
    // Tag all opencode sessions and record in registry
    const tagged = (Array.isArray(ocSessions) ? ocSessions : []).map(s => {
      sessionHarness.set(s.id, "opencode");
      return { ...s, harness: "opencode" };
    });
    const ccList = [...ccSessions.values()].map(s => ({
      id: s.id, title: s.title, time: s.time, harness: "claude-code",
    }));
    const all = [...tagged, ...ccList].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(all));
    return;
  }

  // GET /session/:id — single session lookup (cc in-process, opencode proxied)
  const getOneMatch = p.match(/^\/session\/([^/]+)$/) && req.method === "GET";
  if (getOneMatch) {
    const sid = p.match(/^\/session\/([^/]+)$/)[1];
    if (sessionHarness.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, harness: "claude-code" }));
      return;
    }
    // opencode: proxy and inject harness field
    const ocReq = http.request(UP + p, { method: "GET" }, (ocRes) => {
      let d = ""; ocRes.on("data", c => d += c); ocRes.on("end", () => {
        try { const obj = JSON.parse(d); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...obj, harness: "opencode" })); }
        catch { res.writeHead(ocRes.statusCode || 502); res.end(d); }
      });
    });
    ocReq.on("error", () => { res.writeHead(502); res.end("{}"); });
    ocReq.end();
    return;
  }

  // For message/prompt_async paths: log content tail + probe child before forwarding.
  const isMessagePath = req.method === "POST" &&
    /\/session\/[^/]+\/(message|prompt_async)$/.test(p);

  if (isMessagePath) {
    const raw = await readBody(req);
    const sessionIdMatch = p.match(/^\/session\/([^/]+)\//);
    const sid = sessionIdMatch?.[1];

    // Route cc sessions in-process
    if (sid && sessionHarness.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }

      if (p.endsWith("/prompt_async")) {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch {}
        const text = Array.isArray(body.parts) ? body.parts.filter(p => p.type === "text").map(p => p.text).join("\n") : (body.text ?? "");
        const modelId = body.model?.modelID ?? (process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-6");
        if (!text.trim()) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
        log(`cc prompt_async id=${sid} model=${modelId}`);
        res.writeHead(204); res.end();
        ccRunTurn(cs, text, modelId).catch(e => log(`cc runTurn error id=${sid}:`, e.message));
        return;
      }
      // prompt /message POST (sync) — not commonly used but handle it
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cs.history)); return;
    }

    // opencode session — existing proxy logic
    const tail = extractMsgTail(raw);
    if (tail !== null) log(`message tail for ${p}: ${JSON.stringify(tail)}`);

    const probe = await probeChild();
    if (!probe.ok) {
      log(`child unreachable BEFORE forward on ${p}: ${probe.err || "no response"}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `adapter: child unreachable — ${probe.err || "no response"}` }));
      return;
    }

    const FORCE_MODEL = process.env.FORCE_MODEL !== "0";
    const PINNED_MODEL = process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-6";
    let forwardBody = raw;
    try {
      const b = JSON.parse(raw);
      if (b && b.model && typeof b.model === "object") {
        if (FORCE_MODEL) {
          const before = `${b.model.providerID || ""}/${b.model.modelID || ""}`;
          b.model.providerID = "litellm";
          b.model.modelID = PINNED_MODEL;
          log(`model pin: rewrote ${before} -> litellm/${PINNED_MODEL}`);
        } else if (typeof b.model.modelID === "string") {
          const hasProvider = typeof b.model.providerID === "string" && b.model.providerID.length > 0;
          if (!hasProvider) {
            const slash = b.model.modelID.indexOf("/");
            if (slash > 0) { b.model.providerID = b.model.modelID.slice(0, slash); b.model.modelID = b.model.modelID.slice(slash + 1); }
          }
        }
        forwardBody = JSON.stringify(b);
      }
    } catch {}

    forward(req.method, p, url.search, Buffer.from(forwardBody), res, p);
    return;
  }

  // GET /session/:id/message — route cc sessions to in-process history
  const getMsgMatch = p.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === "GET" && getMsgMatch) {
    const sid = getMsgMatch[1];
    if (sessionHarness.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cs.history));
      return;
    }
    // opencode sessions fall through to the transparent passthrough below
  }

  // GET /event — intercept to merge cc bus events with the opencode SSE stream.
  // We open a persistent connection to the opencode child's /event and pipe its
  // lines to the client, while also registering in ccGlobalBus for cc events.
  if (req.method === "GET" && p === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    // Register cc bus subscriber
    const ccPush = (line) => { try { res.write(line); } catch {} };
    ccGlobalBus.add(ccPush);

    // Proxy the opencode child's /event stream
    const ocReq = http.get(UP + "/event", (ocRes) => {
      ocRes.on("data", (chunk) => { try { res.write(chunk); } catch {} });
      ocRes.on("end", () => { ccGlobalBus.delete(ccPush); try { res.end(); } catch {} });
    });
    ocReq.on("error", () => { ccGlobalBus.delete(ccPush); try { res.end(); } catch {} });

    req.on("close", () => {
      ccGlobalBus.delete(ccPush);
      ocReq.destroy();
    });
    return;
  }

  // Everything else (/event, /session/:id/*, ...) — transparent passthrough.
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, url.search, raw ? Buffer.from(raw) : null, res, p);
});

// Boot the shared opencode serve as a child, then start accepting traffic.
function startChild() {
  log(`spawning: opencode serve on :${CHILD_PORT}`);
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(CHILD_PORT)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => { log(`opencode serve exited (${code}) — shutting down`); process.exit(code ?? 1); });
}

async function waitChild() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      // Ready = the child answers HTTP at all. opencode is installed unpinned, and
      // its `/` route's status code has drifted across versions (200 -> 404/redirect);
      // requiring exactly 200 here silently wedged the deploy ("No open ports on
      // 0.0.0.0") because the adapter never reached server.listen(). Any HTTP
      // response means opencode is up and serving, which is all we need.
      const rq = http.get(UP + "/", (res) => { res.resume(); r((res.statusCode ?? 0) > 0); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

fs.mkdirSync(SKILLS_ROOT, { recursive: true });
startChild();
waitChild().then((ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  log(`listening :${PORT} -> ${UP} | skills=${SKILLS_ROOT}`);
  server.listen(PORT, "0.0.0.0");

  // Periodic child health heartbeat
  const healthTimer = setInterval(async () => {
    const probe = await probeChild();
    if (probe.ok) {
      log(`child health OK (${UP}) | inFlight=${inFlight} restarts=${restartCount} draining=${draining}`);
    } else {
      log(`child health FAIL (${UP}): ${probe.err || "no response"} | restarts=${restartCount}`);
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
});
