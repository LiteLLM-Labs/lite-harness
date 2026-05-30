#!/usr/bin/env node
/*
 * Unified inline adapter — single HTTP server fronting both opencode and
 * claude-code harnesses behind the same 3-endpoint API contract.
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
import { PluginRegistry, createEmitter } from "./plugin-registry.mjs";
import { VaultPlugin } from "./vault-plugin.mjs";
import { HelpPlugin } from "./help-plugin.mjs";
import { LoopPlugin } from "./loop-plugin.mjs";
import { handleMcpRequest, handleMcpSse, handleMcpMessage, PLATFORM_MCP_URL } from "../mcp/index.mjs";
import { initDb as initAgentDb, getAgent, listAgents, deleteAgent } from "../mcp/agents/store.mjs";
import "../mcp/tools.mjs";
import { AgentPlugin } from "./agent-plugin.mjs";
import { initDb, createAgentRun, getAgentRun, updateAgentRun, listAgentRuns } from "./loop-store.mjs";
import { createAgent, setAgentLoop, deleteAgent, listAgents, getAgent, updateAgent } from "./agent-store.mjs";
import { initRunBuffer, bufferRunEvent, subscribeRunEvents, unsubscribeRunEvents, getRunEventBuffer } from "./agent-run-store.mjs";
import {
  hydrateFromDb,
  persistSession,
  appendMessage,
  deleteMessage,
  updateSdkSessionId,
  saveOcMessages,
  setOcSessionChildId,
  loadOcSessions,
  loadMessages,
} from "./session-store.mjs";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");

// ---------------------------------------------------------------------------
// LiteLLM → claude-code SDK wiring.
// The cc SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from process.env.
// Override them here so the cc harness routes via LiteLLM instead of hitting
// api.anthropic.com directly. Safe for the opencode path — opencode reads its
// provider config from opencode.json (explicit baseURL/apiKey), not env vars.
// ---------------------------------------------------------------------------
if (process.env.LITELLM_API_BASE) {
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(/\/+$/, "");
}
if (process.env.LITELLM_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.LITELLM_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.LITELLM_API_KEY;
}

// Bearer-token gate for all HTTP routes. When MASTER_KEY is set, every
// request must carry `Authorization: Bearer <MASTER_KEY>`; when unset, the
// adapter runs open (local dev). The whoami probe is the only exception so
// the login page can validate a key without first being authorized.
const MASTER_KEY = process.env.MASTER_KEY || "";
const DB_PATH = process.env.DB_PATH ||
  path.join(process.env.HOME || "/home/sandbox", ".local", "share", "lite-harness", "db.db");

let CAPABILITIES_CACHE = null;

// Initialize DB synchronously so session hydration runs before any request.
// LoopPlugin.setup() calls initDb() too, but the idempotency guard makes that a no-op.
initDb(DB_PATH);

// Plugin registry — handles /vault, /help, and future slash commands at the
// adapter level before any harness sees the message.
const pluginRegistry = new PluginRegistry();
pluginRegistry.register(new VaultPlugin());
pluginRegistry.register(new HelpPlugin());
pluginRegistry.register(new LoopPlugin());
pluginRegistry.register(new AgentPlugin());
function authOk(req, urlObj) {
  if (!MASTER_KEY) return true;
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof h === "string") {
    const m = h.match(/^Bearer\s+(.+)$/);
    if (m && m[1] === MASTER_KEY) return true;
  }
  // EventSource can't set headers; allow `?key=` query param for /event.
  if (urlObj && urlObj.searchParams.get("key") === MASTER_KEY) return true;
  return false;
}

// Per-session harness tag. opencode sessions exist in the child's DB;
// cc sessions live entirely in-process.
const sessionAgent = new Map(); // id → "opencode" | "cc"

const log = (...a) => console.log("[inline-adapter]", ...a);

// Resolve {{vault.KEY}} and {{config.KEY}} placeholders in agent prompts.
async function resolveTemplates(prompt, userId, config, vaultBackend) {
  if (!prompt) return prompt;
  let result = prompt;
  const vaultMatches = [...result.matchAll(/\{\{vault\.([A-Za-z0-9_]+)\}\}/g)];
  for (const [placeholder, key] of vaultMatches) {
    const val = await vaultBackend.get(`${userId}:${key}`);
    if (val === null) throw new Error(`vault key missing: ${key}`);
    result = result.split(placeholder).join(val);
  }
  const configMatches = [...result.matchAll(/\{\{config\.([A-Za-z0-9_]+)\}\}/g)];
  for (const [placeholder, key] of configMatches) {
    if (!(key in config)) throw new Error(`config key missing: ${key}`);
    result = result.split(placeholder).join(String(config[key]));
  }
  return result;
}

// Load the claude-code SDK from ./claude-code/node_modules/ relative to this
// file. In Docker the adapter lives at /opt/lap/inline-adapter.mjs and the SDK
// is copied to /opt/lap/claude-code/node_modules/. Locally the same layout
// mirrors: harnesses/inline-adapter.mjs → harnesses/claude-code/node_modules/.
const _require = createRequire(import.meta.url);
let ccQuery;
try {
  const sdkPath = _require.resolve(
    "./claude-code/node_modules/@anthropic-ai/claude-code/sdk.mjs",
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
const pluginGlobalBus = new Set(); // SSE writers for plugin-emitted events

// In-process state for github-copilot sessions (declared early so callPromptAsync can close over it).
// The full copilotSessions Map is re-used below; this forward reference is safe because
// callPromptAsync is only *called* at runtime, not at parse time.

// callPromptAsync — unified dispatch used by LoopPlugin (and any future plugin)
// to fire a new prompt into an existing session without going through HTTP.
async function callPromptAsync(sessionId, prompt) {
  const harness = sessionAgent.get(sessionId);
  if (harness === "cc") {
    const cs = ccSessions.get(sessionId);
    if (!cs) throw new Error(`callPromptAsync: cc session ${sessionId} not found`);
    const modelId = process.env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6";
    return ccRunTurn(cs, prompt, modelId);
  }
  if (harness === "github-copilot") {
    const cs = copilotSessions.get(sessionId);
    if (!cs) throw new Error(`callPromptAsync: copilot session ${sessionId} not found`);
    const modelId = process.env.GITHUB_COPILOT_MODEL || "gpt-4o";
    return copilotRunTurn(cs, prompt, modelId);
  }
  if (harness === "codex") {
    const cs = codexSessions.get(sessionId);
    if (!cs) throw new Error(`callPromptAsync: codex session ${sessionId} not found`);
    return codexRunTurn(cs, prompt);
  }
  // opencode — send via HTTP to the child process
  const body = JSON.stringify({ parts: [{ type: "text", text: prompt }] });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${UP}/session/${sessionId}/prompt_async`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => { res.resume(); resolve(); },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Run plugin setup now that callPromptAsync is defined.
pluginRegistry.setup({
  masterKey: MASTER_KEY,
  dbPath: DB_PATH,
  callPromptAsync,
  isSessionActive: (sid) =>
    ccSessions.has(sid) || copilotSessions.has(sid) || codexSessions.has(sid) || sessionAgent.get(sid) === "opencode",
}).catch(e => console.error("[inline-adapter] plugin setup error:", e.message));

// Returns true if a plugin handled the message (response already sent).
async function tryPlugin(text, sid, harness, res) {
  if (!text.trim().startsWith("/")) return false;
  const emitter = createEmitter(sid, (line) => {
    for (const cb of pluginGlobalBus) { try { cb(line); } catch {} }
  });
  res.writeHead(204); res.end();
  pluginRegistry.matchAndHandle(text.trim(), { sessionId: sid, harness }, emitter)
    .catch(e => log(`plugin error sid=${sid}:`, e.message));
  return true;
}

// In-process state for github-copilot sessions.
const copilotSessions = new Map(); // id → {id, title, time, history, busSubscribers}
const copilotGlobalBus = new Set(); // SSE response writers

// In-process state for codex sessions.
const codexSessions = new Map(); // id → {id, title, time, history, busSubscribers, activeProcess}
const codexGlobalBus = new Set(); // SSE response writers

// Opencode session remap: ourId → current opencode child session id (differs after rehydration).
const ocSidRemap = new Map();        // ourId → childSid
const ocSidRemapReverse = new Map(); // childSid → ourId

// Hydrate persisted sessions from SQLite into the in-process Maps.
{
  const { cc, copilot, codex } = hydrateFromDb();
  for (const [id, s] of cc) { ccSessions.set(id, s); sessionHarness.set(id, "cc"); }
  for (const [id, s] of copilot) { copilotSessions.set(id, s); sessionHarness.set(id, "github-copilot"); }
  for (const [id, s] of codex) { codexSessions.set(id, s); sessionHarness.set(id, "codex"); }
  // Opencode sessions: restore sessionHarness + remap (rehydrated sessions have sdk_session_id set)
  const ocRows = loadOcSessions();
  for (const row of ocRows) {
    sessionHarness.set(row.id, "opencode");
    if (row.sdk_session_id && row.sdk_session_id !== row.id) {
      ocSidRemap.set(row.id, row.sdk_session_id);
      ocSidRemapReverse.set(row.sdk_session_id, row.id);
    }
  }
  const total = cc.size + copilot.size + codex.size + ocRows.length;
  if (total > 0) log(`hydrated ${total} session(s) from db (cc=${cc.size} copilot=${copilot.size} codex=${codex.size} opencode=${ocRows.length})`);
}

// Token cache for GitHub Copilot native mode (tokens expire ~30 min)
let _copilotToken = null;
let _copilotTokenExpiry = 0;

const COPILOT_NATIVE_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.85.0",
  "Editor-Plugin-Version": "copilot-chat/0.12.0",
  "Openai-Organization": "github-copilot",
};

function copilotEmit(sessionId, type, props) {
  const ev = { id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type, properties: { ...props, sessionID: sessionId } };
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  const s = copilotSessions.get(sessionId);
  if (s) for (const cb of s.busSubscribers) { try { cb(line); } catch {} }
  for (const cb of copilotGlobalBus) { try { cb(line); } catch {} }
}

// Returns { url, key, extraHeaders } for the chat completions endpoint.
// BYOK mode (LITELLM_API_BASE set): routes to LiteLLM proxy — no GitHub auth needed.
// Native mode (GITHUB_TOKEN set): exchanges GitHub token for a short-lived Copilot token.
async function getCopilotEndpoint() {
  const byokBase = process.env.LITELLM_API_BASE;
  if (byokBase) {
    return {
      url: byokBase.replace(/\/+$/, "") + "/chat/completions",
      key: process.env.LITELLM_API_KEY || "",
      extraHeaders: {},
    };
  }
  // Native GitHub Copilot: exchange GitHub OAuth token for short-lived Copilot token
  if (_copilotToken && Date.now() < _copilotTokenExpiry - 60_000) {
    return { url: "https://api.githubcopilot.com/chat/completions", key: _copilotToken, extraHeaders: COPILOT_NATIVE_HEADERS };
  }
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error("GITHUB_TOKEN not set and LITELLM_API_BASE not configured");
  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { "Authorization": `token ${ghToken}`, "Accept": "application/json", "User-Agent": "lite-harness/1.0" },
  });
  if (!resp.ok) throw new Error(`Copilot token exchange failed: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  _copilotToken = data.token;
  _copilotTokenExpiry = (data.expires_at || 0) * 1000;
  log("github-copilot token refreshed");
  return { url: "https://api.githubcopilot.com/chat/completions", key: _copilotToken, extraHeaders: COPILOT_NATIVE_HEADERS };
}

// OpenAI-format tool definition for save_agent, injected into every copilot request.
const SAVE_AGENT_TOOL = {
  type: "function",
  function: {
    name: "save_agent",
    description: "Save this session as a reusable named agent that can be launched from the CLI with `lite <agent_name>`",
    parameters: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        system_prompt: { type: "string" },
      },
      required: ["agent_name", "system_prompt"],
    },
  },
};

async function copilotRunTurn(s, userText, modelId) {
  const startedAt = Date.now();

  // Build OpenAI messages from session history before adding the new user turn
  const messages = [];
  for (const msg of s.history) {
    const text = (msg.parts || []).filter(p => p.type === "text").map(p => p.text).join("\n");
    if (text) messages.push({ role: msg.info.role === "assistant" ? "assistant" : "user", content: text });
  }
  messages.push({ role: "user", content: userText });

  // Record user message in history
  const userMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const userPart = { id: `${userMsgId}_p0`, messageID: userMsgId, type: "text", text: userText };
  const userMsg = { info: { id: userMsgId, role: "user", time: { created: startedAt, completed: startedAt } }, parts: [userPart] };
  s.history.push(userMsg);
  appendMessage(s.id, userMsg, s.history.length - 1);
  copilotEmit(s.id, "message.updated", { info: userMsg.info });
  copilotEmit(s.id, "message.part.updated", { messageID: userMsgId, part: userPart });

  const asstMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const partID = `${asstMsgId}_b0`;
  let totalText = "";
  let lastError;

  copilotEmit(s.id, "message.updated", { info: { id: asstMsgId, role: "assistant", time: { created: startedAt } } });
  // Emit empty part BEFORE first delta so UI creates the slot
  copilotEmit(s.id, "message.part.updated", { messageID: asstMsgId, part: { id: partID, messageID: asstMsgId, type: "text", text: "" } });

  const model = modelId || process.env.GITHUB_COPILOT_MODEL || "gpt-4o";
  try {
    const endpoint = await getCopilotEndpoint();

    // Agentic loop: re-run if model calls a tool (e.g. save_agent).
    // On each iteration we stream text deltas; if a tool_call fires we
    // execute it and append tool messages, then loop for the next reply.
    let loopMessages = [...messages];
    let toolCallsThisTurn = 0;
    const MAX_TOOL_LOOPS = 5;

    while (true) {
      const resp = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${endpoint.key}`,
          "Content-Type": "application/json",
          ...endpoint.extraHeaders,
        },
        body: JSON.stringify({ model, messages: loopMessages, tools: [SAVE_AGENT_TOOL], stream: true }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Copilot API ${resp.status}: ${errText.slice(0, 300)}`);
      }

      // Parse SSE stream, accumulating both text deltas and tool_call deltas.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // tool_calls are streamed in chunks; accumulate by index.
      const toolCallAccum = {}; // index → { id, name, argumentsRaw }
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { finishReason = finishReason ?? "stop"; break; }
          try {
            const chunk = JSON.parse(payload);
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta;
            if (!delta) continue;
            // Accumulate text content
            if (delta.content) {
              totalText += delta.content;
              copilotEmit(s.id, "message.part.delta", { messageID: asstMsgId, partID, field: "text", delta: delta.content });
            }
            // Accumulate tool_calls deltas
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: "", name: "", argumentsRaw: "" };
                if (tc.id) toolCallAccum[idx].id += tc.id;
                if (tc.function?.name) toolCallAccum[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallAccum[idx].argumentsRaw += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      const pendingToolCalls = Object.values(toolCallAccum);

      // If the model did NOT call any tool, the turn is done.
      if (pendingToolCalls.length === 0 || finishReason !== "tool_calls" || toolCallsThisTurn >= MAX_TOOL_LOOPS) break;

      // Build the assistant message with tool_calls for the next loop iteration.
      const assistantMsg = {
        role: "assistant",
        content: totalText || null,
        tool_calls: pendingToolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argumentsRaw },
        })),
      };
      loopMessages.push(assistantMsg);

      // Execute each tool call and append tool result messages.
      for (const tc of pendingToolCalls) {
        let toolResult = "";
        try {
          let args = {};
          try { args = JSON.parse(tc.argumentsRaw); } catch {}
          if (tc.name === "save_agent") {
            log(`copilot tool call: save_agent agent_name=${args.agent_name}`);
            const mcpResp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(MASTER_KEY ? { "Authorization": `Bearer ${MASTER_KEY}` } : {}) },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_agent", arguments: args } }),
            });
            const mcpJson = await mcpResp.json();
            const resultContent = mcpJson?.result?.content;
            if (Array.isArray(resultContent)) {
              toolResult = resultContent.map(c => c.text ?? JSON.stringify(c)).join("\n");
            } else {
              toolResult = JSON.stringify(mcpJson?.result ?? mcpJson);
            }
            log(`copilot save_agent result: ${toolResult.slice(0, 200)}`);
          } else {
            toolResult = `Unknown tool: ${tc.name}`;
          }
        } catch (toolErr) {
          toolResult = `Tool error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
          log(`copilot tool error: ${toolResult}`);
        }
        loopMessages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
      }

      toolCallsThisTurn++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = { name: "CopilotError", data: { message: msg.slice(0, 500) } };
    log(`copilot turn error id=${s.id}: ${msg}`);
  }

  const completedAt = Date.now();
  const textPart = { id: partID, messageID: asstMsgId, type: "text", text: totalText };
  const fullInfo = { id: asstMsgId, role: "assistant", time: { created: startedAt, completed: completedAt }, harness: "github-copilot", modelID: model, ...(lastError ? { error: lastError } : { finish: "stop" }) };
  s.history.push({ info: fullInfo, parts: [textPart] });
  appendMessage(s.id, { info: fullInfo, parts: [textPart] }, s.history.length - 1);
  s.time.updated = completedAt;
  copilotEmit(s.id, "message.updated", { info: fullInfo });
  copilotEmit(s.id, "session.idle", {});
  log(`copilot turn done id=${s.id} model=${modelId} chars=${totalText.length}`);
}

function codexEmit(sessionId, type, props) {
  const ev = { id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type, properties: { ...props, sessionID: sessionId } };
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  const s = codexSessions.get(sessionId);
  if (s) for (const cb of s.busSubscribers) { try { cb(line); } catch {} }
  for (const cb of codexGlobalBus) { try { cb(line); } catch {} }
}

async function codexRunTurn(s, userText) {
  const startedAt = Date.now();

  // Build context from history for codex prompt
  const contextLines = [];
  for (const msg of s.history) {
    const role = msg.info.role === "assistant" ? "Assistant" : "User";
    const text = (msg.parts || []).filter(p => p.type === "text").map(p => p.text).join("\n");
    if (text) contextLines.push(`${role}: ${text}`);
  }
  const fullPrompt = contextLines.length > 0
    ? `${contextLines.join("\n\n")}\n\nUser: ${userText}`
    : userText;

  // Record user message
  const userMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const userPart = { id: `${userMsgId}_p0`, messageID: userMsgId, type: "text", text: userText };
  const userMsg = { info: { id: userMsgId, role: "user", time: { created: startedAt, completed: startedAt } }, parts: [userPart] };
  s.history.push(userMsg);
  appendMessage(s.id, userMsg, s.history.length - 1);
  codexEmit(s.id, "message.updated", { info: userMsg.info });
  codexEmit(s.id, "message.part.updated", { messageID: userMsgId, part: userPart });

  const asstMsgId = `msg_${randomUUID().replace(/-/g,"").slice(0,20)}`;
  const partID = `${asstMsgId}_b0`;
  let totalText = "";
  let lastError;

  codexEmit(s.id, "message.updated", { info: { id: asstMsgId, role: "assistant", time: { created: startedAt } } });
  codexEmit(s.id, "message.part.updated", { messageID: asstMsgId, part: { id: partID, messageID: asstMsgId, type: "text", text: "" } });

  try {
    const litellmBase = process.env.LITELLM_API_BASE;
    if (!litellmBase) throw new Error("LITELLM_API_BASE not set — codex requires LiteLLM routing");

    const model = process.env.CODEX_MODEL || "gpt-4o";
    const args = [
      "exec",
      "-c", `model_providers.litellm.name=LiteLLM`,
      "-c", `model_providers.litellm.base_url=${litellmBase.replace(/\/+$/, "")}`,
      "-c", `model_providers.litellm.env_key=LITELLM_API_KEY`,
      "-c", `model_provider=litellm`,
      // Inject the platform MCP server so codex sessions can call save_agent.
      // Uses the same -c override mechanism as the model config above.
      // TOML path matches what `codex mcp add --url` writes: [mcp_servers.<name>] / url = "..."
      "-c", `mcp_servers.platform.url="${PLATFORM_MCP_URL}"`,
      "-m", model,
      "--dangerously-bypass-approvals-and-sandbox",
      fullPrompt,
    ];

    const child = spawn("codex", args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    s.activeProcess = child;

    child.stdout.on("data", (chunk) => {
      const delta = chunk.toString("utf8");
      totalText += delta;
      codexEmit(s.id, "message.part.delta", { messageID: asstMsgId, partID, field: "text", delta });
    });

    child.stderr.on("data", (chunk) => {
      log(`codex stderr id=${s.id}: ${chunk.toString("utf8").slice(0, 200)}`);
    });

    await new Promise((resolve, reject) => {
      child.on("exit", (code) => {
        s.activeProcess = null;
        if (code !== 0 && code !== null) reject(new Error(`codex exited with code ${code}`));
        else resolve();
      });
      child.on("error", reject);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = { name: "CodexError", data: { message: msg.slice(0, 500) } };
    log(`codex turn error id=${s.id}: ${msg}`);
  }

  const completedAt = Date.now();
  const textPart = { id: partID, messageID: asstMsgId, type: "text", text: totalText };
  const fullInfo = { id: asstMsgId, role: "assistant", time: { created: startedAt, completed: completedAt }, harness: "codex", modelID: "codex", ...(lastError ? { error: lastError } : { finish: "stop" }) };
  s.history.push({ info: fullInfo, parts: [textPart] });
  appendMessage(s.id, { info: fullInfo, parts: [textPart] }, s.history.length - 1);
  s.time.updated = completedAt;
  codexEmit(s.id, "message.updated", { info: fullInfo });
  codexEmit(s.id, "session.idle", {});
  log(`codex turn done id=${s.id} chars=${totalText.length}`);
}

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
  appendMessage(s.id, userMsg, s.history.length - 1);
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
      ...(s.systemPrompt ? { system: s.systemPrompt } : {}),
      mcpServers: [{ type: "http", url: PLATFORM_MCP_URL }],
    }});
    for await (const m of stream) {
      if (m.type === "system" && m.subtype === "init" && m.session_id && !s.sdkSessionId) s.sdkSessionId = m.session_id;
      ccHandleSdkEvent(s.id, m, parts, asstMsgId, turn, (e) => {
        if (e.error) lastError = e.error;
        if (e.cost !== undefined) totalCost = e.cost;
        if (e.usage) usage = e.usage;
        if (e.sdk_session_id && !s.sdkSessionId) { s.sdkSessionId = e.sdk_session_id; updateSdkSessionId(s.id, e.sdk_session_id); }
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
        deleteMessage(userMsg.info.id);
        s.history.pop();
        s.abortController = null;
        return ccRunTurn(s, userText, modelId);
      }
      lastError = { name: "SDKError", data: { message: msg.slice(0, 500) } };
    }
  } finally { s.abortController = null; }

  const completedAt = Date.now();
  const fullInfo = { id: asstMsgId, role: "assistant", time: { created: startedAt, completed: completedAt }, harness: "claude-code", modelID: modelId, tokens: usage, cost: totalCost, ...(lastError ? { error: lastError } : { finish: "stop" }) };
  s.history.push({ info: fullInfo, parts });
  appendMessage(s.id, { info: fullInfo, parts }, s.history.length - 1);
  s.time.updated = completedAt;
  ccEmit(s.id, "message.updated", { info: fullInfo });
  ccEmit(s.id, "session.idle", {});
  log(`cc turn done id=${s.id} parts=${parts.length}`);
}

// Static UI bundle (Next.js export). Built via `cd ui && npm run build`.
const UI_DIST = path.resolve(
  process.env.UI_DIST ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "ui", "out"),
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
const MSG_TAIL_CHARS = 200;
const STUCK_TIMEOUT_MS = Number(process.env.STUCK_TIMEOUT_MS || 120_000);

// sid → { startedAt, lastEventAt } — only abort when SILENT for STUCK_TIMEOUT_MS,
// not when total elapsed > STUCK_TIMEOUT_MS. Actively-working turns emit events
// frequently; lastEventAt resets on every SSE event so long-running agents survive.
const ocPendingTurns = new Map();

let draining = false;
let inFlight = 0;
let restartCount = 0;
let currentChild = null;

function checkDrainComplete() {
  if (draining && inFlight === 0) {
    log("drain complete — exiting");
    process.exit(0);
  }
}

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

function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9][a-z0-9._-]*$/i.test(m[1]) ? m[1] : null;
}

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

// ── Opencode persistence helpers ─────────────────────────────────────────────

// Fetch messages from the opencode child and save to our DB (idempotent).
async function snapshotOcMessages(ourSid) {
  const childSid = ocSidRemap.get(ourSid) ?? ourSid;
  return new Promise((resolve) => {
    http.get(`${UP}/session/${encodeURIComponent(childSid)}/message`, (r) => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => {
        try { const msgs = JSON.parse(d); if (Array.isArray(msgs)) saveOcMessages(ourSid, msgs); } catch {}
        resolve();
      });
    }).on("error", resolve);
  });
}

// Translate opencode child session IDs in an SSE chunk to our session IDs.
// Needed after rehydration: child uses a new ID but the client expects the original.
function translateOcChunk(chunk) {
  if (!ocSidRemapReverse.size) return chunk;
  const text = chunk.toString("utf8");
  let modified = false;
  const lines = text.split("\n").map(line => {
    if (!line.startsWith("data: ")) return line;
    try {
      const ev = JSON.parse(line.slice(6));
      let changed = false;
      if (ev.properties?.sessionID) {
        const our = ocSidRemapReverse.get(ev.properties.sessionID);
        if (our) { ev.properties.sessionID = our; changed = true; }
      }
      if (ev.properties?.part?.sessionID) {
        const our = ocSidRemapReverse.get(ev.properties.part.sessionID);
        if (our) { ev.properties.part.sessionID = our; changed = true; }
      }
      if (changed) { modified = true; return `data: ${JSON.stringify(ev)}`; }
    } catch {}
    return line;
  });
  return modified ? Buffer.from(lines.join("\n"), "utf8") : chunk;
}

// Ensure the opencode child still has this session. If not, create a fresh
// child session and inject prior history as a preamble in the first user message.
// Returns { childSid, preamble } — preamble is non-null only when we just rehydrated.
async function ensureOcChildAlive(ourSid) {
  const currentChildSid = ocSidRemap.get(ourSid) ?? ourSid;

  const alive = await new Promise((resolve) => {
    http.get(`${UP}/session/${encodeURIComponent(currentChildSid)}`, (r) => {
      r.resume(); resolve(r.statusCode === 200);
    }).on("error", () => resolve(false));
  });
  if (alive) return { childSid: currentChildSid, preamble: null };

  log(`opencode session lost, rehydrating ourSid=${ourSid}`);

  // Create new child session
  const newChildSid = await new Promise((resolve) => {
    const body = JSON.stringify({ title: "Resumed session" });
    const req = http.request(UP + "/session", { method: "POST", headers: { "content-type": "application/json" } }, (r) => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => { try { resolve(JSON.parse(d).id); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end(body);
  });
  if (!newChildSid) { log(`rehydrate: could not create child session`); return { childSid: currentChildSid, preamble: null }; }

  // Build preamble from saved history
  let preamble = null;
  const messages = loadMessages(ourSid);
  if (messages.length > 0) {
    const lines = messages.map(r => {
      const text = JSON.parse(r.parts_json || "[]").filter(p => p.type === "text").map(p => p.text).join("\n").trim();
      const role = JSON.parse(r.info_json || "{}").role === "assistant" ? "Assistant" : "User";
      return text ? `${role}: ${text}` : null;
    }).filter(Boolean);
    if (lines.length) preamble = `<previous_session_history>\n${lines.join("\n\n")}\n</previous_session_history>`;
  }

  // Update maps + DB
  ocSidRemap.set(ourSid, newChildSid);
  ocSidRemapReverse.set(newChildSid, ourSid);
  setOcSessionChildId(ourSid, newChildSid);
  log(`opencode rehydrated ourSid=${ourSid} → newChildSid=${newChildSid} history=${messages.length}msg`);

  return { childSid: newChildSid, preamble };
}

// Per-turn SSE buffers for opencode message persistence.
// Keyed by opencode child session id (what the child emits).
//   ocMsgBuf:   childSid → Map<msgId, { info, parts: Map<partId, part> }>
//   ocPartToSid: partId  → childSid  (reverse index for message.part.delta lookup)
const ocMsgBuf = new Map();
const ocPartToSid = new Map();

// Parse SSE chunks from the opencode event stream.
// - Buffers message.updated / message.part.updated / message.part.delta so we
//   capture full assistant text without relying on GET /message (which omits parts).
// - Flushes buffer to SQLite on session.idle (turn complete).
// - Updates lastEventAt so the stuck watchdog only fires on truly silent turns.
// - Tracks toolInFlight for the 10-minute tool-call timeout.
function tapOcSseChunk(chunk) {
  const text = chunk.toString("utf8");
  const now = Date.now();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      const sid = ev.properties?.sessionID ?? ev.properties?.part?.sessionID;

      // ── Message buffering (runs for all events, not just pending turns) ──
      if (ev.type === "message.updated" && sid && ev.properties?.info?.id) {
        const info = ev.properties.info;
        let msgs = ocMsgBuf.get(sid);
        if (!msgs) { msgs = new Map(); ocMsgBuf.set(sid, msgs); }
        const entry = msgs.get(info.id) ?? { info: null, parts: new Map() };
        entry.info = info;
        msgs.set(info.id, entry);
      } else if (ev.type === "message.part.updated" && sid && ev.properties?.part) {
        const part = ev.properties.part;
        if (part.messageID) {
          const msgs = ocMsgBuf.get(sid);
          const msg = msgs?.get(part.messageID);
          if (msg) {
            msg.parts.set(part.id, { ...part });
            ocPartToSid.set(part.id, sid);
          }
        }
      } else if (ev.type === "message.part.delta" && ev.properties) {
        const { messageID, partID, field, delta } = ev.properties;
        if (partID && field === "text" && typeof delta === "string") {
          const deltaSid = ocPartToSid.get(partID);
          if (deltaSid) {
            const part = ocMsgBuf.get(deltaSid)?.get(messageID)?.parts?.get(partID);
            if (part) part.text = (part.text ?? "") + delta;
          }
        }
      }
      // ────────────────────────────────────────────────────────────────────

      if (!sid || !ocPendingTurns.has(sid)) continue;
      if (ev.type === "session.idle") {
        ocPendingTurns.delete(sid);
        const ourSid = ocSidRemapReverse.get(sid) ?? sid;
        // Flush SSE-buffered messages (full content) to DB.
        const msgs = ocMsgBuf.get(sid);
        if (msgs?.size) {
          const arr = [...msgs.values()]
            .filter(m => m.info)
            .map(m => ({ info: m.info, parts: [...m.parts.values()] }));
          if (arr.length) saveOcMessages(ourSid, arr);
          // Clean up part-to-sid index for this session's parts
          for (const [pid, s] of ocPartToSid) { if (s === sid) ocPartToSid.delete(pid); }
          ocMsgBuf.delete(sid);
        } else {
          // Fallback: fetch from child REST API
          snapshotOcMessages(ourSid).catch(() => {});
        }
      } else {
        const entry = ocPendingTurns.get(sid);
        let toolInFlight = entry.toolInFlight ?? false;
        if (ev.type === "message.part.updated" && ev.properties?.part?.type === "tool") {
          const status = ev.properties.part.state?.status;
          toolInFlight = status === "running";
        }
        ocPendingTurns.set(sid, { ...entry, lastEventAt: now, toolInFlight });
      }
    } catch {}
  }
}

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

async function buildCapabilities() {
  const providers = [];
  if (process.env.LITELLM_API_BASE) providers.push("litellm");
  else if (process.env.ANTHROPIC_API_KEY) providers.push("anthropic");
  const harnessesDir = path.join(path.dirname(new URL(import.meta.url).pathname));
  const knownHarnesses = ["claude-code", "opencode", "github-copilot", "codex"];
  const harnesses = knownHarnesses
    .filter(name => {
      try { return fs.statSync(path.join(harnessesDir, name)).isDirectory(); } catch { return false; }
    })
    .map(name => {
      let version = "unknown";
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(harnessesDir, name, "package.json"), "utf8"));
        version = pkg.version || "unknown";
      } catch {}
      return { name, version, model_providers: providers };
    });

  const mcp_servers = [];
  if (process.env.E2B_API_KEY || process.env.DAYTONA_API_KEY || process.env.LAP_PLATFORM_MODE) {
    mcp_servers.push({
      name: "sandbox",
      description: "Code execution sandbox",
      tools: ["provision", "execute", "read_file", "upload_artifact"],
      auth_required: true,
      auth_type: "api_key",
    });
  }
  const lapBase = process.env.LAP_BASE_URL;
  const lapAccess = process.env.LAP_ACCESS_TOKEN || process.env.LAP_AUTH_TOKEN;
  if (lapBase && (process.env.AGENT_ID || lapAccess)) {
    mcp_servers.push({
      name: "lap-memory",
      description: "Agent memory storage via LAP platform",
      tools: ["memory_store", "memory_get", "memory_list", "memory_delete"],
      auth_required: true,
      auth_type: "bearer_token",
    });
  }
  if (lapBase && lapAccess) {
    mcp_servers.push({
      name: "lap-issue-reporter",
      description: "Report issues to LAP platform",
      tools: ["report_issue"],
      auth_required: true,
      auth_type: "bearer_token",
    });
  }
  // Platform MCP server (same process — call handler directly, no HTTP round-trip)
  try {
    const resp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = resp?.result?.tools ?? [];
    if (tools.length > 0) {
      mcp_servers.push({
        name: "platform",
        description: "Built-in platform tools (save_agent, etc.)",
        tools: tools.map(t => t.name),
        auth_required: !!MASTER_KEY,
        auth_type: "bearer_token",
      });
    }
  } catch {}

  const rawLitellmBase = process.env.LITELLM_API_BASE || "";
  const litellmKey = process.env.LITELLM_API_KEY || "";
  const litellmBase = rawLitellmBase.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (litellmBase && litellmKey) {
    try {
      const r = await fetch(`${litellmBase}/v1/mcp/server`, {
        headers: { Authorization: `Bearer ${litellmKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.servers ?? []);
        for (const s of list) {
          const name = s.alias || s.server_name;
          if (!name) continue;
          mcp_servers.push({
            name,
            description: s.description || "",
            tools: Array.isArray(s.tools) ? s.tools : [],
            auth_required: true,
            auth_type: "bearer_token",
          });
        }
      }
    } catch {}
  }

  const vaultAvailable = !!(process.env.MASTER_KEY || process.env.VAULT_DB_PATH);
  const vault = {
    available: vaultAvailable,
    operations: vaultAvailable ? ["store", "list_keys", "delete"] : [],
  };

  const scheduler = {
    available: true,
    min_interval_minutes: Number(process.env.SCHEDULER_MIN_INTERVAL_MINUTES ?? 1),
    cron_supported: false,
    manual_trigger: false,
  };

  let sandbox = null;
  if (process.env.LAP_PLATFORM_MODE) {
    sandbox = { provider: "lap-platform", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  } else if (process.env.E2B_API_KEY) {
    sandbox = { provider: "e2b", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  } else if (process.env.DAYTONA_API_KEY) {
    sandbox = { provider: "daytona", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  }

  return {
    harnesses,
    mcp_servers,
    vault,
    scheduler,
    ...(sandbox && { sandbox }),
    agents: {},
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ harness: "inline", ok: true, draining, inFlight, restartCount, ui: UI_DIST_EXISTS }));
    return;
  }

  if (req.method === "GET" && UI_DIST_EXISTS && serveStatic(p, res)) return;

  if (p === "/whoami" && req.method === "GET") {
    if (!authOk(req, url)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, auth: MASTER_KEY ? "required" : "open" }));
    return;
  }

  if (p === "/api/capabilities" && (req.method === "GET" || req.method === "OPTIONS")) {
    res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end(req.method === "OPTIONS" ? "" : JSON.stringify(CAPABILITIES_CACHE));
    return;
  }

  if (!authOk(req, url)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Gateway health probe used by the Settings dialog's "Test connection"
  // button. Pings ${LITELLM_API_BASE}/v1/models with LITELLM_API_KEY and
  // reports whether the gateway is reachable and how many models it serves.
  if (p === "/_litellm/health" && req.method === "GET") {
    const base = (process.env.LITELLM_API_BASE || "").replace(/\/+$/, "");
    const key = process.env.LITELLM_API_KEY || "";
    if (!base) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "LITELLM_API_BASE not set" }));
      return;
    }
    const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(modelsUrl, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = await r.text();
      if (!r.ok) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, status: r.status, error: body.slice(0, 500), base, modelsUrl }));
        return;
      }
      let modelCount = 0;
      try {
        const j = JSON.parse(body);
        if (Array.isArray(j?.data)) modelCount = j.data.length;
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, modelCount, base, modelsUrl }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e), base, modelsUrl }));
    }
    return;
  }

  // MCP Streamable HTTP transport: POST /mcp
  if (p === "/mcp" && req.method === "POST") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const raw = await readBody(req);
    let mcpBody = {};
    try { mcpBody = JSON.parse(raw || "{}"); } catch {}
    const response = await handleMcpRequest(mcpBody);
    if (response === null) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // MCP HTTP+SSE transport (legacy): GET /mcp/sse
  if (p === "/mcp/sse" && req.method === "GET") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    handleMcpSse(req, res, `/mcp/message`);
    return;
  }

  // MCP HTTP+SSE transport: POST /mcp/message?sessionId=xxx
  if (p === "/mcp/message" && req.method === "POST") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const sessionId = url.searchParams.get("sessionId") || "";
    const raw = await readBody(req);
    let mcpBody = {};
    try { mcpBody = JSON.parse(raw || "{}"); } catch {}
    await handleMcpMessage(mcpBody, sessionId);
    res.writeHead(202); res.end();
    return;
  }

  if (p === "/agents" && req.method === "GET") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listAgents()));
    return;
  }

  const agentRouteMatch = p.match(/^\/agents\/([^/]+)$/);
  if (agentRouteMatch && req.method === "GET") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const a = getAgent(decodeURIComponent(agentRouteMatch[1]));
    if (!a) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(a));
    return;
  }

  if (agentRouteMatch && req.method === "DELETE") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    deleteAgent(decodeURIComponent(agentRouteMatch[1]));
    res.writeHead(204); res.end();
    return;
  }

  // Reject NEW session creates while draining; all other in-flight paths continue.
  if (draining && p === "/session" && req.method === "POST") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server is draining — no new sessions accepted" }));
    return;
  }

  const contentLength = req.headers["content-length"] || "?";
  log(`→ ${req.method} ${p} (${contentLength} bytes)`);

  inFlight++;
  let decremented = false;
  const decrement = () => { if (!decremented) { decremented = true; inFlight--; checkDrainComplete(); } };
  res.on("finish", decrement);
  res.on("close", decrement);

  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}

    const agentParam = body.agent ?? body.harness;
    const builtin = agentParam === "claude-code" ? "cc" : agentParam === "github-copilot" ? "github-copilot" : agentParam === "codex" ? "codex" : agentParam === "cc" ? "cc" : agentParam === "opencode" ? "opencode" : null;

    let systemPromptOverride = body.systemPrompt || null;

    if (!builtin) {
      let savedAgent = null;
      try { savedAgent = getAgent(agentParam); } catch {}
      if (!savedAgent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown agent: ${agentParam}` }));
        return;
      }
      systemPromptOverride = savedAgent.system_prompt;
      body.title = body.title || savedAgent.name;
    }
    const resolvedAgent = builtin ?? "cc";

    if (resolvedAgent === "github-copilot") {
      if (!process.env.LITELLM_API_BASE && !process.env.GITHUB_TOKEN) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "github-copilot requires LITELLM_API_BASE (BYOK) or GITHUB_TOKEN (native Copilot)" }));
        return;
      }
      const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const now = Date.now();
      const s = { id, title: body.title || "New session", time: { created: now }, history: [], busSubscribers: new Set() };
      copilotSessions.set(id, s);
      sessionAgent.set(id, "github-copilot");
      sessionHarness.set(id, "github-copilot");
      persistSession({ id, harness: "github-copilot", title: s.title, createdAt: now });
      log(`copilot session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "github-copilot" }));
      return;
    }

    if (resolvedAgent === "codex") {
      if (!process.env.LITELLM_API_BASE) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "codex requires LITELLM_API_BASE" }));
        return;
      }
      const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const now = Date.now();
      const s = { id, title: body.title || "New session", time: { created: now }, history: [], busSubscribers: new Set(), activeProcess: null };
      codexSessions.set(id, s);
      sessionAgent.set(id, "codex");
      sessionHarness.set(id, "codex");
      persistSession({ id, harness: "codex", title: s.title, createdAt: now });
      log(`codex session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "codex" }));
      return;
    }

    if (resolvedAgent === "cc") {
      if (!ccQuery) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "claude-code SDK not available" }));
        return;
      }
      const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const now = Date.now();
      const s = { id, title: body.title || "New session", time: { created: now }, agent: "claude-code", sdkSessionId: null, abortController: null, history: [], busSubscribers: new Set(), systemPrompt: systemPromptOverride };
      ccSessions.set(id, s);
      sessionAgent.set(id, "cc");
      sessionHarness.set(id, "cc");
      persistSession({ id, harness: "cc", title: s.title, createdAt: now });
      log(`cc session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "claude-code" }));
      return;
    }

    const n = materializeSkills(body.files);
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s) title=${JSON.stringify(body.title || "")}`);
    const { harness: _h, agent: _a, ...forwardBody } = body;
    forwardBody.mcp = { ...(forwardBody.mcp || {}), platform: { type: "remote", url: PLATFORM_MCP_URL, enabled: true } };
    const upReq = http.request(UP + "/session", { method: "POST", headers: { "content-type": "application/json" } }, (upRes) => {
      let respData = "";
      upRes.on("data", c => respData += c);
      upRes.on("end", () => {
        try {
          const parsed = JSON.parse(respData);
          if (parsed.id) {
            sessionAgent.set(parsed.id, "opencode");
            sessionHarness.set(parsed.id, "opencode");
            persistSession({ id: parsed.id, harness: "opencode", title: parsed.title || "New session", createdAt: Date.now() });
          }
        } catch {}
        res.writeHead(upRes.statusCode || 200, upRes.headers);
        res.end(respData);
      });
    });
    upReq.on("error", (e) => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); } });
    upReq.end(JSON.stringify(forwardBody));
    return;
  }

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
    const tagged = (Array.isArray(ocSessions) ? ocSessions : []).map(s => {
      sessionAgent.set(s.id, "opencode");
      return { ...s, agent: "opencode" };
    });
    // Merge in DB-persisted opencode sessions not currently known to the child.
    const liveOcIds = new Set(tagged.map(s => s.id));
    const dbOcExtra = loadOcSessions()
      .filter(r => !liveOcIds.has(r.id))
      .map(r => {
        sessionHarness.set(r.id, "opencode");
        return { id: r.id, title: r.title, time: { created: r.created_at, ...(r.updated_at ? { updated: r.updated_at } : {}) }, harness: "opencode" };
      });
    const ccList = [...ccSessions.values()].map(s => ({
      id: s.id, title: s.title, time: s.time, agent: "claude-code",
    }));
    const copilotList = [...copilotSessions.values()].map(s => ({
      id: s.id, title: s.title, time: s.time, agent: "github-copilot",
    }));
    const codexList = [...codexSessions.values()].map(s => ({
      id: s.id, title: s.title, time: s.time, agent: "codex",
    }));
    const all = [...tagged, ...dbOcExtra, ...ccList, ...copilotList, ...codexList].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(all));
    return;
  }

  const getOneMatch = p.match(/^\/session\/([^/]+)$/) && req.method === "GET";
  if (getOneMatch) {
    const sid = p.match(/^\/session\/([^/]+)$/)[1];
    if (sessionAgent.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "claude-code" }));
      return;
    }
    if (sessionAgent.get(sid) === "github-copilot") {
      const cs = copilotSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "github-copilot" }));
      return;
    }
    if (sessionAgent.get(sid) === "codex") {
      const cs = codexSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "codex" }));
      return;
    }
    // opencode: proxy and inject agent field
    const ocReq = http.request(UP + p, { method: "GET" }, (ocRes) => {
      let d = ""; ocRes.on("data", c => d += c); ocRes.on("end", () => {
        try { const obj = JSON.parse(d); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...obj, agent: "opencode" })); }
        catch { res.writeHead(ocRes.statusCode || 502); res.end(d); }
      });
    });
    ocReq.on("error", () => { res.writeHead(502); res.end("{}"); });
    ocReq.end();
    return;
  }

  const isMessagePath = req.method === "POST" &&
    /\/session\/[^/]+\/(message|prompt_async)$/.test(p);

  if (isMessagePath) {
    const raw = await readBody(req);
    const sessionIdMatch = p.match(/^\/session\/([^/]+)\//);
    const sid = sessionIdMatch?.[1];

    if (sid && sessionAgent.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }

      if (p.endsWith("/prompt_async")) {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch {}
        const text = Array.isArray(body.parts) ? body.parts.filter(p => p.type === "text").map(p => p.text).join("\n") : (body.text ?? "");
        if (await tryPlugin(text, sid, "cc", res)) return;
        // Strip provider prefix (e.g. "anthropic/claude-opus-4-7" → "claude-opus-4-7") —
        // the Anthropic API and LiteLLM's Anthropic-compatible endpoint both expect the
        // bare model name without a provider prefix.
        const rawModel = body.model?.modelID ?? (process.env.LITELLM_DEFAULT_MODEL || "claude-sonnet-4-6");
        const modelId = rawModel.includes("/") ? rawModel.slice(rawModel.indexOf("/") + 1) : rawModel;
        if (!text.trim()) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
        log(`cc prompt_async id=${sid} model=${modelId}`);
        res.writeHead(204); res.end();
        ccRunTurn(cs, text, modelId).catch(e => log(`cc runTurn error id=${sid}:`, e.message));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cs.history)); return;
    }

    // Route codex sessions in-process
    if (sid && sessionAgent.get(sid) === "codex") {
      const cs = codexSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }

      if (p.endsWith("/prompt_async")) {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch {}
        const text = Array.isArray(body.parts) ? body.parts.filter(p => p.type === "text").map(p => p.text).join("\n") : (body.text ?? "");
        if (await tryPlugin(text, sid, "codex", res)) return;
        if (!text.trim()) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
        log(`codex prompt_async id=${sid}`);
        res.writeHead(204); res.end();
        codexRunTurn(cs, text).catch(e => log(`codex runTurn error id=${sid}:`, e.message));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cs.history)); return;
    }

    // Route github-copilot sessions in-process
    if (sid && sessionAgent.get(sid) === "github-copilot") {
      const cs = copilotSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }

      if (p.endsWith("/prompt_async")) {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch {}
        const text = Array.isArray(body.parts) ? body.parts.filter(p => p.type === "text").map(p => p.text).join("\n") : (body.text ?? "");
        if (await tryPlugin(text, sid, "github-copilot", res)) return;
        const modelId = body.model?.modelID ?? (process.env.GITHUB_COPILOT_MODEL || "gpt-4o");
        if (!text.trim()) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
        log(`copilot prompt_async id=${sid} model=${modelId}`);
        res.writeHead(204); res.end();
        copilotRunTurn(cs, text, modelId).catch(e => log(`copilot runTurn error id=${sid}:`, e.message));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(cs.history)); return;
    }

    // opencode session — plugin intercept before proxying to child
    if (p.endsWith("/prompt_async") && sid) {
      let _body = {};
      try { _body = JSON.parse(raw || "{}"); } catch {}
      const _text = Array.isArray(_body.parts) ? _body.parts.filter(pt => pt.type === "text").map(pt => pt.text).join("\n") : (_body.text ?? "");
      if (await tryPlugin(_text, sid, "opencode", res)) return;
    }

    const tail = extractMsgTail(raw);
    if (tail !== null) log(`message tail for ${p}: ${JSON.stringify(tail)}`);

    const probe = await probeChild();
    if (!probe.ok) {
      log(`child unreachable BEFORE forward on ${p}: ${probe.err || "no response"}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `adapter: child unreachable — ${probe.err || "no response"}` }));
      return;
    }

    // Client picks the model. If they pass "anthropic/claude-x" as modelID,
    // split it into providerID + modelID so opencode looks it up correctly.
    const FORCE_MODEL = process.env.FORCE_MODEL !== "0";
    const PINNED_MODEL = process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-6";
    let forwardBody = raw;
    try {
      const b = JSON.parse(raw);
      if (b && b.model && typeof b.model === "object") {
        if (FORCE_MODEL) {
          const before = `${b.model.providerID || ""}/${b.model.modelID || ""}`;
          b.model.providerID = process.env.PROVIDER_NAME || "litellm";
          b.model.modelID = PINNED_MODEL;
          log(`model pin: rewrote ${before} -> ${b.model.providerID}/${PINNED_MODEL}`);
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

    if (p.endsWith("/prompt_async") && sid) {
      const now = Date.now();
      if (sessionHarness.get(sid) === "opencode") {
        const { childSid, preamble } = await ensureOcChildAlive(sid);
        if (preamble) {
          try {
            const b = JSON.parse(forwardBody);
            const userText = (b.parts || []).filter(pt => pt.type === "text").map(pt => pt.text).join("\n");
            b.parts = [{ type: "text", text: `${preamble}\n\nPlease continue the conversation. User message: ${userText}` }];
            forwardBody = JSON.stringify(b);
          } catch {}
        }
        const childPath = childSid !== sid ? p.replace(`/session/${sid}/`, `/session/${childSid}/`) : p;
        ocPendingTurns.set(childSid, { startedAt: now, lastEventAt: now });
        forward(req.method, childPath, url.search, Buffer.from(forwardBody), res, p);
        return;
      }
      ocPendingTurns.set(sid, { startedAt: now, lastEventAt: now });
    }
    forward(req.method, p, url.search, Buffer.from(forwardBody), res, p);
    return;
  }

  const getMsgMatch = p.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === "GET" && getMsgMatch) {
    const sid = getMsgMatch[1];
    if (sessionAgent.get(sid) === "cc") {
      const cs = ccSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cs.history));
      return;
    }
    if (sessionAgent.get(sid) === "github-copilot") {
      const cs = copilotSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cs.history));
      return;
    }
    if (sessionAgent.get(sid) === "codex") {
      const cs = codexSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session not found" })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cs.history));
      return;
    }
    // opencode: try child, fall back to our DB for lost sessions
    if (sessionHarness.get(sid) === "opencode") {
      const childSid = ocSidRemap.get(sid) ?? sid;
      const childMsgs = await new Promise((resolve) => {
        http.get(`${UP}/session/${encodeURIComponent(childSid)}/message`, (r) => {
          let d = ""; r.on("data", c => d += c);
          r.on("end", () => { try { resolve(r.statusCode === 200 ? JSON.parse(d) : null); } catch { resolve(null); } });
        }).on("error", () => resolve(null));
      });
      const msgs = childMsgs ?? loadMessages(sid).map(r => ({ info: JSON.parse(r.info_json), parts: JSON.parse(r.parts_json) }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(msgs));
      return;
    }
  }

  if (req.method === "GET" && p === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const ccPush = (line) => { try { res.write(line); } catch {} };
    ccGlobalBus.add(ccPush);
    const copilotPush = (line) => { try { res.write(line); } catch {} };
    copilotGlobalBus.add(copilotPush);
    const codexPush = (line) => { try { res.write(line); } catch {} };
    codexGlobalBus.add(codexPush);
    const pluginPush = (line) => { try { res.write(line); } catch {} };
    pluginGlobalBus.add(pluginPush);

    const ocReq = http.get(UP + "/event", (ocRes) => {
      ocRes.on("data", (chunk) => { tapOcSseChunk(chunk); try { res.write(translateOcChunk(chunk)); } catch {} });
      ocRes.on("end", () => { ccGlobalBus.delete(ccPush); copilotGlobalBus.delete(copilotPush); codexGlobalBus.delete(codexPush); pluginGlobalBus.delete(pluginPush); try { res.end(); } catch {} });
    });
    ocReq.on("error", () => { ccGlobalBus.delete(ccPush); copilotGlobalBus.delete(copilotPush); codexGlobalBus.delete(codexPush); pluginGlobalBus.delete(pluginPush); try { res.end(); } catch {} });

    req.on("close", () => {
      ccGlobalBus.delete(ccPush);
      copilotGlobalBus.delete(copilotPush);
      codexGlobalBus.delete(codexPush);
      pluginGlobalBus.delete(pluginPush);
      ocReq.destroy();
    });
    return;
  }

  // GET /v1/models — proxy to LiteLLM gateway so the UI model switcher can
  // load available models dynamically.
  if (req.method === "GET" && p === "/v1/models") {
    const base = (process.env.LITELLM_API_BASE || "").replace(/\/$/, "");
    const apiKey = process.env.LITELLM_API_KEY || "";
    if (!base) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "LITELLM_API_BASE not configured" }));
      return;
    }
    try {
      const upstream = `${base}/models`;
      const r = await fetch(upstream, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const body = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream error: ${e.message}` }));
    }
    return;
  }

  // POST /session/:id/abort — cancel an in-flight turn.
  const abortMatch = p.match(/^\/session\/([^/]+)\/abort$/);
  if (abortMatch && req.method === "POST") {
    const sid = abortMatch[1];
    const harness = sessionAgent.get(sid);
    if (harness === "cc") {
      const cs = ccSessions.get(sid);
      if (cs?.abortController) { cs.abortController.abort(); log(`abort: cc sid=${sid}`); }
      res.writeHead(204); res.end();
      return;
    }
    if (harness === "github-copilot") {
      res.writeHead(204); res.end();
      return;
    }
    if (harness === "codex") {
      const cs = codexSessions.get(sid);
      if (cs?.activeProcess) { cs.activeProcess.kill("SIGTERM"); cs.activeProcess = null; log(`abort: codex sid=${sid}`); }
      res.writeHead(204); res.end();
      return;
    }
    // opencode: clear pending tracking and forward to child
    ocPendingTurns.delete(sid);
    forward("POST", p, "", null, res, p);
    return;
  }

  // ── GET /api/capabilities ────────────────────────────────────────────────────
  if (req.method === "GET" && p === "/api/capabilities") {
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    const loopPlugin = pluginRegistry.getPlugin("loop");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      harnesses: [{ name: "claude-code", version: "1.0" }],
      mcp_servers: [],
      vault: { available: !!(vaultPlugin && vaultPlugin.backend) },
      scheduler: { available: !!loopPlugin, min_interval_minutes: 1 },
      sandbox: {
        provider: process.env.E2B_API_KEY ? "e2b" : null,
        pip_install: true,
        outbound_network: true,
        persistent_storage: false,
        max_runtime_minutes: 30,
      },
    }));
    return;
  }

  // ── Vault HTTP endpoints ──────────────────────────────────────────────────────
  const _vaultUserMatch = p.match(/^\/api\/vault\/([^/]+)$/);
  const _vaultKeyMatch  = p.match(/^\/api\/vault\/([^/]+)\/([^/]+)$/);

  if (_vaultUserMatch && req.method === "POST") {
    const userId = _vaultUserMatch[1];
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const { key, value } = body;
    if (!key || value === undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "key and value required" }));
      return;
    }
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    if (!vaultPlugin || !vaultPlugin.backend) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vault not available" }));
      return;
    }
    await vaultPlugin.backend.set(`${userId}:${key}`, value);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, key }));
    return;
  }

  if (_vaultUserMatch && req.method === "GET") {
    const userId = _vaultUserMatch[1];
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    if (!vaultPlugin || !vaultPlugin.backend) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vault not available" }));
      return;
    }
    const prefix = `${userId}:`;
    const all = await vaultPlugin.backend.list();
    const keys = all
      .filter(r => r.key.startsWith(prefix))
      .map(r => ({ key: r.key.slice(prefix.length), updated_at: r.updatedAt }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys }));
    return;
  }

  if (_vaultKeyMatch && req.method === "DELETE") {
    const userId = _vaultKeyMatch[1];
    const key    = _vaultKeyMatch[2];
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    if (!vaultPlugin || !vaultPlugin.backend) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vault not available" }));
      return;
    }
    await vaultPlugin.backend.delete(`${userId}:${key}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Agent CRUD + run routes ───────────────────────────────────────────────────
  const _agentRunLogsMatch = p.match(/^\/api\/agents\/([^/]+)\/runs\/([^/]+)\/logs$/);
  const _agentRunsMatch    = p.match(/^\/api\/agents\/([^/]+)\/runs$/);
  const _agentRunMatch     = p.match(/^\/api\/agents\/([^/]+)\/run$/);
  const _agentPauseMatch   = p.match(/^\/api\/agents\/([^/]+)\/pause$/);
  const _agentResumeMatch  = p.match(/^\/api\/agents\/([^/]+)\/resume$/);
  const _agentIdMatch      = p.match(/^\/api\/agents\/([^/]+)$/);
  const _agentsMatch       = p === "/api/agents";

  if (_agentsMatch && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const {
      name, owner_id, description,
      harness: agentHarness = "claude-code",
      prompt, schedule,
      vault_keys = [], setup_commands = [],
      max_runtime_minutes = 30,
      on_failure = "pause_and_notify",
      config = {},
      model = "claude-sonnet-4-6",
      system = "",
    } = body;
    if (!name || !owner_id) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "name and owner_id required" }));
      return;
    }
    // Validate vault_keys exist before accepting the agent
    if (vault_keys.length > 0) {
      const vaultPlugin = pluginRegistry.getPlugin("vault");
      if (vaultPlugin && vaultPlugin.backend) {
        const missing = [];
        for (const k of vault_keys) {
          const v = await vaultPlugin.backend.get(`${owner_id}:${k}`);
          if (v === null) missing.push(k);
        }
        if (missing.length > 0) {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "vault keys missing", missing }));
          return;
        }
      }
    }
    // Create an ephemeral builder session so the agent has a session_id
    const builderSid = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const builderNow = Date.now();
    ccSessions.set(builderSid, {
      id: builderSid, title: `agent-builder-${name}`,
      time: { created: builderNow }, harness: "claude-code",
      sdkSessionId: null, abortController: null, history: [], busSubscribers: new Set(),
    });
    sessionHarness.set(builderSid, "cc");
    persistSession({ id: builderSid, harness: "cc", title: `agent-builder-${name}`, createdAt: builderNow });

    const newAgent = createAgent({
      name, model, system: system || prompt || "", tools: [],
      cadence: schedule ? schedule.cron : null, intervalSeconds: null,
      sessionId: builderSid, loopId: null,
      prompt: prompt || null,
      cron: schedule ? schedule.cron : null,
      timezone: schedule ? (schedule.timezone || "UTC") : "UTC",
      vault_keys, setup_commands, max_runtime_minutes, on_failure,
      config, owner_id, status: "paused", description: description || null,
      harness: agentHarness,
    });
    const host = req.headers.host || "localhost";
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: newAgent.id,
      name: newAgent.name,
      owner_id: newAgent.owner_id,
      status: newAgent.status || "paused",
      url: `https://${host}/agents/${newAgent.id}`,
      schedule: schedule ? { cron: schedule.cron, timezone: schedule.timezone || "UTC" } : null,
      created_at: newAgent.created_at,
    }));
    return;
  }

  if (_agentsMatch && req.method === "GET") {
    const ownerId = url.searchParams.get("owner_id");
    const agents = listAgents(ownerId || undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ agents }));
    return;
  }

  if (_agentIdMatch && req.method === "GET") {
    const agentId = _agentIdMatch[1];
    const found = getAgent(agentId);
    if (!found) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(found));
    return;
  }

  if (_agentIdMatch && req.method === "PATCH") {
    const agentId = _agentIdMatch[1];
    const existing = getAgent(agentId);
    if (!existing) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const raw = await readBody(req);
    let fields = {};
    try { fields = JSON.parse(raw || "{}"); } catch {}
    updateAgent(agentId, fields);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getAgent(agentId)));
    return;
  }

  if (_agentIdMatch && req.method === "DELETE") {
    const agentId = _agentIdMatch[1];
    const existing = getAgent(agentId);
    if (!existing) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    deleteAgent(agentId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (_agentPauseMatch && req.method === "POST") {
    const agentId = _agentPauseMatch[1];
    const existing = getAgent(agentId);
    if (!existing) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    updateAgent(agentId, { status: "paused" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: agentId, status: "paused" }));
    return;
  }

  if (_agentResumeMatch && req.method === "POST") {
    const agentId = _agentResumeMatch[1];
    const existing = getAgent(agentId);
    if (!existing) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    updateAgent(agentId, { status: "active" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: agentId, status: "active" }));
    return;
  }

  // ── POST /api/agents/:id/run ──────────────────────────────────────────────────
  if (_agentRunMatch && req.method === "POST") {
    const agentId = _agentRunMatch[1];
    const agentDef = getAgent(agentId);
    if (!agentDef) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent not found" }));
      return;
    }
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const configOverrides = body.config_overrides || {};

    // Validate vault_keys exist before burning sandbox time
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    if (agentDef.vault_keys && agentDef.vault_keys.length > 0) {
      if (!vaultPlugin || !vaultPlugin.backend) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "vault not available" }));
        return;
      }
      const missing = [];
      for (const k of agentDef.vault_keys) {
        const v = await vaultPlugin.backend.get(`${agentDef.owner_id}:${k}`);
        if (v === null) missing.push(k);
      }
      if (missing.length > 0) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "vault keys missing", missing }));
        return;
      }
    }

    // Resolve prompt templates ({{vault.X}} and {{config.X}})
    const mergedConfig = Object.assign({}, agentDef.config || {}, configOverrides);
    let resolvedPrompt = agentDef.prompt || agentDef.system || "";
    try {
      if (vaultPlugin && vaultPlugin.backend) {
        resolvedPrompt = await resolveTemplates(
          resolvedPrompt, agentDef.owner_id || "default", mergedConfig, vaultPlugin.backend
        );
      }
    } catch (e) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }

    // Create ephemeral cc session for this run
    if (!ccQuery) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "claude-code SDK not available" }));
      return;
    }
    const runSid = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const runNow = Date.now();
    ccSessions.set(runSid, {
      id: runSid, title: `agent-run-${agentId}`,
      time: { created: runNow }, harness: "claude-code",
      sdkSessionId: null, abortController: null, history: [], busSubscribers: new Set(),
    });
    sessionHarness.set(runSid, "cc");
    persistSession({ id: runSid, harness: "cc", title: `agent-run-${agentId}`, createdAt: runNow });

    const runRecord = createAgentRun({ agentId, sessionId: runSid, configOverrides });
    const runId = runRecord.id;
    initRunBuffer(runId);

    // Listen on the global SSE bus to track run completion and buffer events
    const runEventListener = (line) => {
      try {
        const m = line.match(/^data: (.+)\n/);
        if (!m) return;
        const evt = JSON.parse(m[1]);
        if (evt.properties && evt.properties.sessionID !== runSid) return;
        bufferRunEvent(runId, line);
        if (evt.type === "session.idle") {
          updateAgentRun(runId, { status: "completed", finishedAt: Date.now() });
          ccGlobalBus.delete(runEventListener);
          pluginGlobalBus.delete(runEventListener);
        } else if (evt.type === "session.error") {
          const errMsg = (evt.properties && evt.properties.error && evt.properties.error.message) || "unknown error";
          updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: errMsg });
          if (agentDef.on_failure === "pause_and_notify") {
            updateAgent(agentId, { status: "paused" });
          }
          ccGlobalBus.delete(runEventListener);
          pluginGlobalBus.delete(runEventListener);
        }
      } catch {}
    };
    ccGlobalBus.add(runEventListener);
    pluginGlobalBus.add(runEventListener);

    // Fire prompt async — non-blocking
    callPromptAsync(runSid, resolvedPrompt).catch((e) => {
      log(`run ${runId} error: ${e.message}`);
      updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: e.message });
      ccGlobalBus.delete(runEventListener);
      pluginGlobalBus.delete(runEventListener);
    });

    const host = req.headers.host || "localhost";
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({
      run_id: runId,
      agent_id: agentId,
      status: "starting",
      logs_url: `https://${host}/api/agents/${agentId}/runs/${runId}/logs`,
    }));
    return;
  }

  // ── GET /api/agents/:id/runs/:runId/logs (SSE stream) ────────────────────────
  if (_agentRunLogsMatch && req.method === "GET") {
    const agentId = _agentRunLogsMatch[1];
    const runId   = _agentRunLogsMatch[2];
    const runRec = getAgentRun(runId);
    if (!runRec || runRec.agent_id !== agentId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "run not found" }));
      return;
    }
    const terminal = ["completed", "failed", "timed_out", "cancelled"];
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (terminal.includes(runRec.status)) {
      // Run already done — flush buffered events and close
      const buffered = getRunEventBuffer(runId) || [];
      for (const line of buffered) { try { res.write(line); } catch {} }
      res.end();
      return;
    }
    // Live stream: subscribe to run's event buffer
    const liveListener = (line) => { try { res.write(line); } catch {} };
    subscribeRunEvents(runId, liveListener);
    req.on("close", () => unsubscribeRunEvents(runId, liveListener));
    return;
  }

  // ── GET /api/agents/:id/runs ──────────────────────────────────────────────────
  if (_agentRunsMatch && req.method === "GET") {
    const agentId = _agentRunsMatch[1];
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 100);
    const runs = listAgentRuns(agentId, limit);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ runs }));
    return;
  }

  // Everything else (/event, /session/:id/*, ...) — transparent passthrough.
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, url.search, raw ? Buffer.from(raw) : null, res, p);
});

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
      const rq = http.get(UP + "/", (res) => { res.resume(); r((res.statusCode ?? 0) > 0); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

fs.mkdirSync(SKILLS_ROOT, { recursive: true });
initAgentDb();

// Inject platform MCP into opencode.json before child starts so opencode
// discovers save_agent at startup (opencode reads config once, not per-session).
const ocWorkdir = process.env.OPENCODE_INLINE_WORKDIR;
if (ocWorkdir) {
  const ocConfigPath = path.join(ocWorkdir, "opencode.json");
  try {
    if (fs.existsSync(ocConfigPath)) {
      const cfg = JSON.parse(fs.readFileSync(ocConfigPath, "utf8"));
      const platformEntry = { type: "remote", url: PLATFORM_MCP_URL, enabled: true };
      if (MASTER_KEY) platformEntry.headers = { Authorization: `Bearer ${MASTER_KEY}` };
      cfg.mcp = { ...(cfg.mcp || {}), platform: platformEntry };
      fs.writeFileSync(ocConfigPath, JSON.stringify(cfg, null, 2));
      log("injected platform MCP into opencode.json");
    }
  } catch (e) {
    log(`platform MCP injection warning: ${e.message}`);
  }
}

// Start HTTP server BEFORE opencode so platform MCP is reachable when
// opencode connects to it during startup (opencode pings MCP servers on init).
server.listen(PORT, "0.0.0.0", () => {
  log(`adapter listening :${PORT} (platform MCP ready)`);
});

startChild();
waitChild().then(async (ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  CAPABILITIES_CACHE = await buildCapabilities();
  log(`opencode ready :${PORT} -> ${UP} | skills=${SKILLS_ROOT}`);

  const healthTimer = setInterval(async () => {
    const probe = await probeChild();
    if (probe.ok) {
      log(`child health OK (${UP}) | inFlight=${inFlight} restarts=${restartCount} draining=${draining}`);
    } else {
      log(`child health FAIL (${UP}): ${probe.err || "no response"} | restarts=${restartCount}`);
    }
    // Auto-abort opencode turns that have been SILENT for STUCK_TIMEOUT_MS.
    // Actively working turns emit SSE events; lastEventAt resets on each one.
    // Exception: if a tool call is in flight, tolerate up to 10 minutes of
    // silence — MCP tools like push_files can take several minutes with no
    // SSE events between tool-start and tool-result.
    const TOOL_STUCK_TIMEOUT_MS = 600_000;
    const now = Date.now();
    for (const [sid, { lastEventAt, startedAt, toolInFlight }] of ocPendingTurns) {
      const timeout = toolInFlight ? TOOL_STUCK_TIMEOUT_MS : STUCK_TIMEOUT_MS;
      if (now - lastEventAt > timeout) {
        log(`auto-abort stuck turn: sid=${sid} silent=${Math.round((now - lastEventAt) / 1000)}s total=${Math.round((now - startedAt) / 1000)}s toolInFlight=${!!toolInFlight}`);
        ocPendingTurns.delete(sid);
        const ar = http.request(`${UP}/session/${sid}/abort`, { method: "POST" }, (r) => {
          r.resume();
          log(`auto-abort response: sid=${sid} status=${r.statusCode}`);
        });
        ar.on("error", (e) => log(`auto-abort error: sid=${sid} ${e.message}`));
        ar.end();
      }
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
});
