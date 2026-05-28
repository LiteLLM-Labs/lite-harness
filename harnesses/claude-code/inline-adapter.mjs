#!/usr/bin/env node
/**
 * Claude Code inline adapter.
 *
 * Exposes the same HTTP contract as the opencode harness:
 *   POST /session                    create session → {id, title, time}
 *   GET  /session                    list sessions
 *   DELETE /session/:id              delete session
 *   POST /session/:id/prompt_async   queue a user turn (returns 204)
 *   GET  /session/:id/message        list messages (user+assistant history)
 *   POST /session/:id/abort          cancel in-flight turn
 *   GET  /event                      SSE bus — same event shapes as opencode
 *   GET  /health                     JSON health probe
 *   GET  *                           static UI (ui/out/)
 *
 * The SSE /event stream emits:
 *   message.updated        {info: {id, role, time, ...}}
 *   message.part.updated   {messageID, part: {id, type, text|tool|...}}
 *   message.part.delta     {messageID, partID, field, delta}
 *   session.idle           {} — fired when a turn completes
 *
 * LiteLLM routing: set ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY from
 *   LITELLM_API_BASE / LITELLM_API_KEY before the SDK spawns claude.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 4098);
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();
const DEFAULT_MODEL =
  process.env.LITELLM_DEFAULT_MODEL ?? "claude-sonnet-4-5";

const UI_DIST = path.resolve(
  path.join(fileURLToPath(import.meta.url), "..", "..", "..", "ui", "out"),
);
const UI_DIST_EXISTS = fs.existsSync(UI_DIST);

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

const log = (...a) => console.log("[claude-code]", ...a);

// ---------------------------------------------------------------------------
// LiteLLM → Claude Code env wiring
// ---------------------------------------------------------------------------

if (process.env.LITELLM_API_BASE) {
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(/\/+$/, "");
}
if (process.env.LITELLM_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.LITELLM_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.LITELLM_API_KEY;
}

// ---------------------------------------------------------------------------
// SDK import — resolve from this package's node_modules
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
let querySdk;
try {
  // sdk.mjs is the programmatic entry point (not the CLI binary)
  const sdkPath = _require.resolve("@anthropic-ai/claude-code/sdk.mjs");
  querySdk = await import(sdkPath);
} catch (e) {
  log("FATAL: cannot import @anthropic-ai/claude-code:", e.message);
  process.exit(1);
}
const { query } = querySdk;

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   time: {created: number, updated?: number},
 *   sdkSessionId: string | null,
 *   abortController: AbortController | null,
 *   history: Array<{info: object, parts: object[]}>,
 *   busSubscribers: Set<function>,
 * }} Session
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

function makeSession(title) {
  const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const now = Date.now();
  /** @type {Session} */
  const s = {
    id,
    title: title || "New session",
    time: { created: now },
    sdkSessionId: null,
    abortController: null,
    history: [],
    busSubscribers: new Set(),
  };
  sessions.set(id, s);
  return s;
}

// ---------------------------------------------------------------------------
// SSE bus helpers
// ---------------------------------------------------------------------------

/** @type {Set<function>} */
const globalBusSubscribers = new Set();

function emit(s, type, props) {
  const event = { id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type, properties: { ...props, sessionID: s.id } };
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const cb of s.busSubscribers) { try { cb(line); } catch {} }
  for (const cb of globalBusSubscribers) { try { cb(line); } catch {} }
}

// ---------------------------------------------------------------------------
// SDK event → bus translation
// ---------------------------------------------------------------------------

/**
 * Translate one SDK message into bus events and accumulate parts.
 * Mirrors the handleSdkEvent logic from claude-agent-sdk/src/server.ts.
 */
function handleSdkEvent(s, m, parts, msgId, turn, sink) {
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
        emit(s, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "thinking") {
        const thinkingKey = `${sdkMsgId}:${blockIdx}`;
        const streamAccum = turn.thinkingAccum.get(thinkingKey) ?? "";
        const part = {
          id: partId, messageID: msgId, type: "reasoning",
          text: (block.thinking || streamAccum),
        };
        parts.push(part);
        emit(s, "message.part.updated", { messageID: msgId, part });
      } else if (block.type === "tool_use") {
        const part = {
          id: partId, messageID: msgId, type: "tool",
          tool: block.name, callID: block.id,
          state: { input: block.input, status: "running" },
        };
        parts.push(part);
        emit(s, "message.part.updated", { messageID: msgId, part });
      }
    });
    turn.asstBlockCount.set(sdkMsgId ?? "", seenBlocks + content.length);
  } else if (ev.type === "user" && ev.message) {
    const content = ev.message.content ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const matching = parts.filter(p => p.type === "tool").find(p => p.callID === block.tool_use_id);
      if (!matching) continue;
      const out = Array.isArray(block.content)
        ? block.content.map(c => c.type === "text" ? (c.text ?? "") : "").join("")
        : typeof block.content === "string" ? block.content : "";
      matching.state.status = block.is_error ? "error" : "completed";
      matching.state.output = out;
      if (block.is_error) matching.state.error = out;
      emit(s, "message.part.updated", { messageID: msgId, part: matching });
    }
  } else if (ev.type === "result") {
    sink({
      cost: ev.total_cost_usd,
      usage: {
        input: ev.usage?.input_tokens,
        output: ev.usage?.output_tokens,
        cache: {
          read: ev.usage?.cache_read_input_tokens,
          write: ev.usage?.cache_creation_input_tokens,
        },
      },
    });
    if (ev.is_error) {
      sink({ error: { name: "ResultError", data: { message: String(ev.result ?? "agent error") } } });
    }
  } else if (ev.type === "stream_event") {
    const inner = ev.event;
    if (inner?.type === "message_start" && inner.message?.id) {
      turn.currentSdkMsgId = inner.message.id;
      turn.blockIdxsBySdkMsgId.set(inner.message.id, []);
      return;
    }
    if (inner?.type === "content_block_start" && typeof inner.index === "number" && turn.currentSdkMsgId) {
      const arr = turn.blockIdxsBySdkMsgId.get(turn.currentSdkMsgId) ?? [];
      arr[inner.index] = turn.nextGlobalIdx++;
      turn.blockIdxsBySdkMsgId.set(turn.currentSdkMsgId, arr);
      return;
    }
    if (inner?.type === "content_block_delta" && typeof inner.index === "number" && turn.currentSdkMsgId) {
      const partID = `${turn.currentSdkMsgId}_b${inner.index}`;
      if (inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
        emit(s, "message.part.delta", { messageID: msgId, partID, field: "text", delta: inner.delta.text });
      } else if (inner.delta?.type === "thinking_delta" && typeof inner.delta.thinking === "string") {
        const thinkingKey = `${turn.currentSdkMsgId}:${inner.index}`;
        const prev = turn.thinkingAccum.get(thinkingKey) ?? "";
        turn.thinkingAccum.set(thinkingKey, prev + inner.delta.thinking);
        emit(s, "message.part.delta", { messageID: msgId, partID, field: "reasoning", delta: inner.delta.thinking });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Run one agent turn
// ---------------------------------------------------------------------------

async function runTurn(s, userText, modelId) {
  const startedAt = Date.now();
  const ac = new AbortController();
  s.abortController = ac;

  // Synthesize + emit the user message immediately
  const userMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const userPart = { id: `${userMsgId}_p0`, messageID: userMsgId, type: "text", text: userText };
  const userMsg = { info: { id: userMsgId, role: "user", time: { created: startedAt, completed: startedAt } }, parts: [userPart] };
  s.history.push(userMsg);
  emit(s, "message.updated", { info: userMsg.info });
  emit(s, "message.part.updated", { messageID: userMsgId, part: userPart });

  const assistantMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const parts = [];
  let lastError;
  let totalCost;
  let usage;

  const turn = {
    nextGlobalIdx: 0,
    currentSdkMsgId: null,
    blockIdxsBySdkMsgId: new Map(),
    thinkingAccum: new Map(),
    asstBlockCount: new Map(),
  };

  // Emit placeholder assistant message so UI knows a turn started
  const assistantInfo = { id: assistantMsgId, role: "assistant", time: { created: startedAt } };
  emit(s, "message.updated", { info: assistantInfo });

  try {
    const stream = query({
      prompt: userText,
      options: {
        model: modelId,
        cwd: REPO_DIR,
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        abortController: ac,
        disallowedTools: ["AskUserQuestion"],
        ...(s.sdkSessionId ? { resume: s.sdkSessionId } : {}),
      },
    });

    for await (const m of stream) {
      if (m.type === "system" && m.subtype === "init" && m.session_id && !s.sdkSessionId) {
        s.sdkSessionId = m.session_id;
      }
      handleSdkEvent(s, m, parts, assistantMsgId, turn, (e) => {
        if (e.error) lastError = e.error;
        if (e.cost !== undefined) totalCost = e.cost;
        if (e.usage) usage = e.usage;
        if (e.sdk_session_id && !s.sdkSessionId) s.sdkSessionId = e.sdk_session_id;
      });
    }
  } catch (err) {
    if (ac.signal.aborted) {
      lastError = { name: "AbortError", data: { message: "run aborted" } };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      // Stale SDK session — retry fresh once
      if (s.sdkSessionId && msg.includes("Blocked")) {
        log(`stale bridge session, retrying fresh (session=${s.id})`);
        s.sdkSessionId = null;
        s.history.pop();
        s.abortController = null;
        return runTurn(s, userText, modelId);
      }
      log(`SDK error session=${s.id}:`, err.message);
      lastError = { name: "SDKError", data: { message: msg.slice(0, 500) } };
    }
  } finally {
    s.abortController = null;
  }

  const completedAt = Date.now();
  const fullAssistantInfo = {
    ...assistantInfo,
    time: { created: startedAt, completed: completedAt },
    tokens: usage,
    cost: totalCost,
    ...(lastError ? { error: lastError } : { finish: "stop" }),
  };
  const assistantMsg = { info: fullAssistantInfo, parts };
  s.history.push(assistantMsg);
  s.time.updated = completedAt;

  emit(s, "message.updated", { info: fullAssistantInfo });
  emit(s, "session.idle", {});
  log(`turn done session=${s.id} parts=${parts.length} cost=${totalCost ?? "?"}`);
  return assistantMsg;
}

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const candidates = [rel];
  if (!path.extname(rel)) {
    candidates.push(path.join(rel, "index.html"), rel + ".html");
  }
  for (const c of candidates) {
    const abs = path.resolve(UI_DIST, c);
    if (!abs.startsWith(UI_DIST + path.sep) && abs !== UI_DIST) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const ctype = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": ctype, "content-length": stat.size,
      "cache-control": rel.startsWith("_next/") ? "public,max-age=31536000,immutable" : "no-cache" });
    fs.createReadStream(abs).pipe(res);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise(r => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => r(b)); });
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  // Health
  if (p === "/health" || p === "/healthz") {
    return json(res, 200, { harness: "claude-code", ok: true, model: DEFAULT_MODEL, sessions: sessions.size });
  }

  // Static UI
  if (method === "GET" && UI_DIST_EXISTS && serveStatic(p, res)) return;

  // GET /session — list
  if (method === "GET" && p === "/session") {
    return json(res, 200, [...sessions.values()].map(s => ({
      id: s.id, title: s.title, time: s.time,
    })).sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0)));
  }

  // POST /session — create
  if (method === "POST" && p === "/session") {
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch {}
    const s = makeSession(body.title);
    log(`session created id=${s.id} title=${JSON.stringify(s.title)}`);
    return json(res, 200, { id: s.id, title: s.title, time: s.time });
  }

  // DELETE /session/:id
  const delMatch = p.match(/^\/session\/([^/]+)$/);
  if (method === "DELETE" && delMatch) {
    const s = sessions.get(delMatch[1]);
    if (s) { s.abortController?.abort(); sessions.delete(s.id); }
    return json(res, 200, {});
  }

  // GET /session/:id/message
  const msgMatch = p.match(/^\/session\/([^/]+)\/message$/);
  if (method === "GET" && msgMatch) {
    const s = sessions.get(msgMatch[1]);
    if (!s) return json(res, 404, { error: "session not found" });
    return json(res, 200, s.history);
  }

  // POST /session/:id/prompt_async
  const promptMatch = p.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (method === "POST" && promptMatch) {
    const s = sessions.get(promptMatch[1]);
    if (!s) return json(res, 404, { error: "session not found" });
    let body = {};
    try { body = JSON.parse(await readBody(req) || "{}"); } catch {}
    const text = Array.isArray(body.parts)
      ? body.parts.filter(p => p.type === "text").map(p => p.text).join("\n")
      : (body.text ?? "");
    const modelId = body.model?.modelID ?? DEFAULT_MODEL;
    if (!text.trim()) return json(res, 400, { error: "no text" });
    log(`prompt_async session=${s.id} model=${modelId} text=${JSON.stringify(text.slice(0, 80))}`);
    res.writeHead(204);
    res.end();
    // Run async — don't await
    runTurn(s, text, modelId).catch(err => log(`runTurn uncaught session=${s.id}:`, err.message));
    return;
  }

  // POST /session/:id/abort
  const abortMatch = p.match(/^\/session\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const s = sessions.get(abortMatch[1]);
    s?.abortController?.abort();
    return json(res, 200, {});
  }

  // GET /event — SSE bus
  if (method === "GET" && p === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Send connected heartbeat
    res.write(`data: ${JSON.stringify({ id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type: "server.connected", properties: {} })}\n\n`);

    // Filter by sessionID query param if provided (matches opencode behaviour)
    const filterSid = url.searchParams.get("sessionId") ?? null;

    const push = (line) => {
      if (filterSid) {
        try { const d = JSON.parse(line.replace(/^data: /, "")); if (d.properties?.sessionID && d.properties.sessionID !== filterSid) return; } catch {}
      }
      try { res.write(line); } catch {}
    };

    globalBusSubscribers.add(push);
    const ka = setInterval(() => { try { res.write(`:heartbeat\n\n`); } catch {} }, 15000);
    req.on("close", () => { globalBusSubscribers.delete(push); clearInterval(ka); });
    return;
  }

  // GET /v1/models — proxy to LiteLLM gateway for the UI model switcher.
  if (method === "GET" && p === "/v1/models") {
    const base = (process.env.LITELLM_API_BASE || "").replace(/\/$/, "");
    const apiKey = process.env.LITELLM_API_KEY || "";
    if (!base) {
      return json(res, 503, { error: "LITELLM_API_BASE not configured" });
    }
    try {
      const r = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const body = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(body);
    } catch (e) {
      json(res, 502, { error: `upstream error: ${e.message}` });
    }
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`listening :${PORT} | model=${DEFAULT_MODEL} | ui=${UI_DIST_EXISTS} | cwd=${REPO_DIR}`);
});

process.on("SIGTERM", () => { log("SIGTERM — shutting down"); server.close(() => process.exit(0)); });
