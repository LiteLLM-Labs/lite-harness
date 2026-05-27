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

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");

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

const log = (...a) => console.log("[inline-adapter]", ...a);

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
    const n = materializeSkills(body.files);
    // Drop skill files from the forwarded body — opencode would otherwise
    // re-write them (to the same path) after create, which is just wasted work.
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s) title=${JSON.stringify(body.title || "")}`);
    forward("POST", "/session", "", Buffer.from(JSON.stringify(body)), res, "session-create");
    return;
  }

  // For message/prompt_async paths: log content tail + probe child before forwarding.
  const isMessagePath = req.method === "POST" &&
    /\/session\/[^/]+\/(message|prompt_async)$/.test(p);

  if (isMessagePath) {
    const raw = await readBody(req);

    // Log message content tail
    const tail = extractMsgTail(raw);
    if (tail !== null) {
      log(`message tail for ${p}: ${JSON.stringify(tail)}`);
    }

    // Probe child before forwarding — surfaces ECONNREFUSED immediately
    // instead of letting the request hang until the upstream times out.
    const probe = await probeChild();
    if (!probe.ok) {
      log(`child unreachable BEFORE forward on ${p}: ${probe.err || "no response"}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `adapter: child unreachable — ${probe.err || "no response"}` }));
      return;
    }

    // Normalize model field.
    //
    // The OpenCode UI advertises models from its own built-in catalog
    // (e.g. "Claude Sonnet 4.6"), but the LiteLLM gateway only exposes
    // whatever the proxy config lists. When the UI sends a model the
    // gateway doesn't know, the upstream call returns model-not-found
    // and opencode hangs waiting on a stream that never starts.
    //
    // Hard-pin to the LITELLM_DEFAULT_MODEL the entrypoint discovered
    // (which we know is valid because /v1/models returned it at boot).
    // This makes "the UI should respond with any selected model" actually
    // hold — the user can pick anything in the dropdown and we route to
    // a working model. Override with FORCE_MODEL=0 to disable.
    const FORCE_MODEL = process.env.FORCE_MODEL !== "0";
    const PINNED_MODEL = process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-5";
    let forwardBody = raw;
    try {
      const b = JSON.parse(raw);
      if (b && b.model && typeof b.model === "object") {
        if (FORCE_MODEL) {
          // Match the local chat UI shape — providerID points at the gateway
          // adapter configured in opencode.json, modelID is the gateway-known
          // model id (with the "anthropic/" prefix kept verbatim).
          const before = `${b.model.providerID || ""}/${b.model.modelID || ""}`;
          b.model.providerID = "litellm";
          b.model.modelID = PINNED_MODEL;
          log(`model pin: rewrote ${before} -> litellm/${PINNED_MODEL}`);
        } else if (typeof b.model.modelID === "string") {
          // Legacy behaviour when FORCE_MODEL=0: split bare "anthropic/foo"
          // when caller didn't set providerID.
          const hasProvider = typeof b.model.providerID === "string" && b.model.providerID.length > 0;
          if (!hasProvider) {
            const slash = b.model.modelID.indexOf("/");
            if (slash > 0) {
              b.model.providerID = b.model.modelID.slice(0, slash);
              b.model.modelID = b.model.modelID.slice(slash + 1);
            }
          }
        }
        forwardBody = JSON.stringify(b);
      }
    } catch {}

    forward(req.method, p, url.search, Buffer.from(forwardBody), res, p);
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
