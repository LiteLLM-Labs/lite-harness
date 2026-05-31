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
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PluginRegistry, createEmitter } from "./plugin-registry.mjs";
import { VaultPlugin } from "./vault-plugin.mjs";
import { HelpPlugin } from "./help-plugin.mjs";
import { LoopPlugin } from "./loop-plugin.mjs";
import { handleMcpRequest, handleMcpSse, handleMcpMessage, PLATFORM_MCP_URL } from "../mcp/index.mjs";
import { initDb as initAgentDb, getAgent as getSavedAgent, listAgents as listSavedAgents, deleteAgent as deleteSavedAgent } from "../mcp/agents/store.mjs";
import { wireInbox, handleInboxRoute } from "./inbox-service.mjs";
import "../mcp/tools.mjs";
import { AgentPlugin } from "./agent-plugin.mjs";
import { initDb, getDb, createLoop, createAgentRun, getAgentRun, updateAgentRun, listAgentRuns, getSlackThreadSession, upsertSlackThreadSession } from "./loop-store.mjs";
import { Cron } from "croner";
import { createAgent, setAgentLoop, deleteAgent, listAgents, getAgent, updateAgent } from "./agent-store.mjs";
import { createSkill, listSkills, getSkill, getSkillsByIds, updateSkill, deleteSkill } from "./skills-store.mjs";
import { storeMemory, listMemory, deleteMemory, deleteAllMemory } from "./memory-store.mjs";
import { initRunBuffer, bufferRunEvent, subscribeRunEvents, unsubscribeRunEvents, getRunEventBuffer, setRunSandbox, getRunSandbox } from "./agent-run-store.mjs";
import { buildDirectProvider } from "./sandbox-provider.mjs";
import { fetchSlackThreadContext } from "./slack-thread-context.mjs";
import { createAssistantTextAccumulator, createSlackRunStreamer } from "./slack-run-stream.mjs";
import { upsertAgentFile, listAgentFiles, listAgentFilesWithContent, getAgentFile, deleteAgentFile, deleteAllAgentFiles, FILE_LIMITS, isBinaryAgentFile } from "./agent-file-store.mjs";
import {
  hydrateFromDb,
  persistSession,
  getSessionAgentId,
  getSessionTz,
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
const SANDBOX_WORKSPACE_DIR = process.env.SANDBOX_WORKSPACE_DIR || "/home/user/workspace";

// ---------------------------------------------------------------------------
// LiteLLM → claude-code SDK wiring.
// The cc SDK reads ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from process.env.
// Override them here so the cc harness routes via LiteLLM instead of hitting
// api.anthropic.com directly. Safe for the opencode path — opencode reads its
// provider config from opencode.json (explicit baseURL/apiKey), not env vars.
// ---------------------------------------------------------------------------
if (process.env.LITELLM_API_BASE) {
  // The Anthropic/claude-code SDK appends "/v1/messages" to ANTHROPIC_BASE_URL, so
  // strip any trailing "/v1" from LITELLM_API_BASE to avoid a doubled "/v1/v1/messages"
  // (which the gateway 404s). opencode keeps the "/v1" base via opencode.json.
  process.env.ANTHROPIC_BASE_URL = process.env.LITELLM_API_BASE.replace(/\/+$/, "").replace(/\/v1$/, "");
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

// Mark any runs stuck in "starting" for >10 min as timed_out. Happens when
// the server restarts mid-run or session.idle was never caught (e.g. pre-ocGlobalBus).
try {
  getDb().prepare(
    `UPDATE agent_runs SET status = 'timed_out', finished_at = ? WHERE status = 'starting' AND started_at < ?`
  ).run(Date.now(), Date.now() - 10 * 60 * 1000);
} catch {}

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

function isSlackIngressRoute(pathname) {
  return /^\/host-oauth-callback\/[^/]+$/.test(pathname) ||
    /^\/api\/agents\/[^/]+\/slack\/(?:events|interactivity)$/.test(pathname);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== "string") return "";
  return value.split(",")[0]?.trim() || "";
}

function externalOrigin(req) {
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) || firstHeaderValue(req.headers.host) || `localhost:${PORT}`;
  let proto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  if (!proto) {
    proto = host.includes("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]")
      ? "http"
      : "https";
  }
  return `${proto}://${host}`;
}

// Per-session harness tag. opencode sessions exist in the child's DB;
// cc sessions live entirely in-process.
const sessionAgent = new Map(); // id → "opencode" | "cc"
const sessionHarness = sessionAgent; // alias — same map, two names from merged branches
const sessionSystemPrompt = new Map(); // sid -> system prompt for opencode agents (applied on first turn)
const ocSysPromptDelivered = new Set();
const slackEventIds = new Set();
const slackMessageKeys = new Set();

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

// Build the effective system prompt for an agent run, composing three layers:
//   1. A default preamble exposing the *skills* concept (a catalog of every
//      skill on the platform), so any agent knows what's available and can ask
//      to use more.
//   2. The full content of each skill attached to the agent (skill_ids).
//   3. The agent's own `system` prompt.
// `attachedSkills` / `allSkills` are rows from skills-store.
function composeAgentSystem(agentSystem, attachedSkills, allSkills) {
  const parts = [];
  const catalog = (allSkills || [])
    .map((s) => `- ${s.name} (${s.id})${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
  parts.push(
    "## Skills available on this platform\n" +
      "Skills are reusable capability playbooks. The platform currently has:\n" +
      (catalog || "(none yet)") +
      "\n\nThe skills attached to you are included in full below — follow them. " +
      "To list the latest catalog at runtime, GET /api/skills on the harness.",
  );
  for (const sk of attachedSkills || []) {
    parts.push(`## Skill: ${sk.name}\n${sk.content}`);
  }
  if (agentSystem && agentSystem.trim()) parts.push(agentSystem.trim());
  return parts.join("\n\n---\n\n");
}

// A system-prompt note telling an agent its own id and how to use the memory
// tools. The platform memory_* tools are shared across all agents, so each call
// must be scoped by agent_id — we hand the agent its id here so it can pass it.
function memoryPromptNote(agentId) {
  if (!agentId) return "";
  let alwaysOnBlock = "";
  try {
    const alwaysOn = listMemory(agentId).filter((m) => Number(m.always_on) === 1);
    if (alwaysOn.length > 0) {
      alwaysOnBlock =
        `\n\nAlways-on memories loaded for this session:\n` +
        alwaysOn.map((m) => `- ${m.key}: ${m.value}`).join("\n");
    }
  } catch {}
  return (
    `\n\n---\n\n## Your memory\nYour agent_id is "${agentId}". You have a durable memory ` +
    `(key→value notes) that persists across sessions and scheduled runs. Pass this exact ` +
      `agent_id to the memory tools: memory_list (recall everything — do this at the start of a ` +
      `task), memory_get (read one key), memory_store (save/overwrite a key), memory_delete ` +
      `(forget a key). Use memory to remember facts, preferences, and decisions worth keeping.` +
      alwaysOnBlock
  );
}

function agentRunHarness(agentDef) {
  return agentDef.harness === "claude-code"
    ? "cc"
    : agentDef.harness === "github-copilot"
      ? "github-copilot"
      : agentDef.harness === "codex"
        ? "codex"
        : "opencode";
}

function latestAssistantText(session) {
  const messages = Array.isArray(session?.history) ? session.history : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "assistant") continue;
    const text = (msg.parts || [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function verifySlackSignature(req, rawBody, signingSecret) {
  if (!signingSecret) return true;
  const timestamp = firstHeaderValue(req.headers["x-slack-request-timestamp"]);
  const signature = firstHeaderValue(req.headers["x-slack-signature"]);
  if (!timestamp || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function slackApi(method, token, payload) {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.ok === false) {
    throw new Error(body.error || `slack_${method}_${resp.status}`);
  }
  return body;
}

async function liteLlmChat(messages, model) {
  const base = process.env.LITELLM_API_BASE?.replace(/\/+$/, "");
  const key = process.env.LITELLM_API_KEY;
  if (!base || !key) throw new Error("litellm_env_missing");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("litellm_timeout")), 45_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model || process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-6",
        messages,
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: ac.signal,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body?.error?.message || body?.message || `litellm_http_${resp.status}`);
    const text = body?.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string") throw new Error("litellm_empty_reply");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function runAgentForSlack(agentDef, slackEvent, slackThreadContext = "", { onStreamText } = {}) {
  const userText = slackEvent.text || "";
  const threadTs = slackEvent.thread_ts || slackEvent.ts;
  const existingThreadSession = getSlackThreadSession(agentDef.id, slackEvent.channel, threadTs);
  const threadContextBlock = slackThreadContext
    ? `Slack thread history, oldest to newest:
${slackThreadContext}

Use the thread history to preserve conversation context. The current message is marked in the transcript and is also repeated below.`
    : "Slack thread history was unavailable; use the current message below.";
  const slackPrompt = `Slack message received for this agent.

Workspace team: ${slackEvent.team || "unknown"}
Channel: ${slackEvent.channel || "unknown"}
Thread timestamp: ${threadTs || "unknown"}
User: ${slackEvent.user || "unknown"}
${threadContextBlock}

Message:
${userText}

Carry out the agent task using this Slack message as the user-provided context.
Return only the exact reply text to send back in Slack.
Do not call Slack tools, DM tools, post-message tools, or any other messaging tools. The platform will post your returned text back to Slack for you.`;

  const resp = await fetch(`http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(agentDef.id)}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(MASTER_KEY ? { authorization: `Bearer ${MASTER_KEY}` } : {}),
    },
    body: JSON.stringify({
      prompt: slackPrompt,
      session_id: existingThreadSession?.session_id || undefined,
      config_overrides: {
        slack: {
          channel: slackEvent.channel,
          thread_ts: threadTs,
          user: slackEvent.user,
          ts: slackEvent.ts,
        },
      },
    }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || `agent_run_http_${resp.status}`);
  if (body.session_id) upsertSlackThreadSession(agentDef.id, slackEvent.channel, threadTs, body.session_id);

  const runId = body.run_id;
  const deadline = Date.now() + Math.max(1, Number(agentDef.max_runtime_minutes) || 30) * 60_000;
  let run = null;
  let streamListener = null;
  if (typeof onStreamText === "function" && body.session_id) {
    const accumulator = createAssistantTextAccumulator(body.session_id);
    streamListener = (line) => {
      const text = accumulator.ingestLine(line);
      if (text) onStreamText(text);
    };
    ocGlobalBus.add(streamListener);
    ccGlobalBus.add(streamListener);
    pluginGlobalBus.add(streamListener);
  }
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      run = getAgentRun(runId);
      if (run?.status === "completed" || run?.status === "failed") break;
    }
  } finally {
    if (streamListener) {
      ocGlobalBus.delete(streamListener);
      ccGlobalBus.delete(streamListener);
      pluginGlobalBus.delete(streamListener);
    }
  }
  if (!run || run.status !== "completed") {
    throw new Error(run?.error || "agent run did not complete");
  }

  const messages = await getOcMessages(run.session_id);
  const text = latestAssistantText({ history: messages });
  return { runId, text: text || `Agent run completed: ${runId}` };
}

async function handleSlackEventAsync(agentId, body) {
  const connectionAgent = getAgent(agentId);
  if (!connectionAgent) return;
  const config = connectionAgent.config && typeof connectionAgent.config === "object" ? connectionAgent.config : {};
  const slack = config.slack && typeof config.slack === "object" ? config.slack : {};
  const runAgentId = typeof slack.run_agent_id === "string" && slack.run_agent_id.trim()
    ? slack.run_agent_id.trim()
    : agentId;
  const agentDef = getAgent(runAgentId);
  if (!agentDef) {
    log(`[slack] run agent ${runAgentId} not found for Slack app agent ${agentId}`);
    return;
  }
  const event = body.event || {};
  if (!event || event.bot_id || event.subtype || event.user === slack.bot_user_id) return;
  const isMention = event.type === "app_mention";
  const isMessage = event.type === "message" && ["im", "mpim"].includes(event.channel_type);
  if ((!isMention && !isMessage) || !String(event.text || "").trim()) return;
  const messageKey = `${agentId}:${runAgentId}:${event.channel || ""}:${event.ts || ""}`;
  if (event.ts && slackMessageKeys.has(messageKey)) return;
  if (event.ts) {
    slackMessageKeys.add(messageKey);
    setTimeout(() => slackMessageKeys.delete(messageKey), 10 * 60 * 1000).unref?.();
  }

  const vaultPlugin = pluginRegistry.getPlugin("vault");
  const tokenKey = slack.bot_token_key;
  const botToken = vaultPlugin?.backend && tokenKey
    ? await vaultPlugin.backend.get(`default:${tokenKey}`)
    : null;
  if (!botToken) {
    log(`[slack] missing bot token for agent ${agentId}`);
    return;
  }

  try {
    await slackApi("reactions.add", botToken, {
      channel: event.channel,
      timestamp: event.ts,
      name: "eyes",
    }).catch(() => {});
    const threadTs = event.thread_ts || event.ts;
    let slackThreadContext = "";
    try {
      slackThreadContext = await fetchSlackThreadContext({
        slackApi,
        botToken,
        channel: event.channel,
        threadTs,
        currentTs: event.ts,
      });
    } catch (e) {
      log(`[slack] failed to fetch thread context for ${agentId}->${runAgentId}:`, e instanceof Error ? e.message : String(e));
    }
    const streamer = createSlackRunStreamer({
      slackApi,
      botToken,
      channel: event.channel,
      threadTs,
    });
    await streamer.start("Working...");
    const result = await runAgentForSlack(agentDef, { ...event, team: body.team_id }, slackThreadContext, {
      onStreamText: (text) => {
        streamer.update(text).catch((e) => {
          log(`[slack] failed to stream update for ${agentId}:`, e instanceof Error ? e.message : String(e));
        });
      },
    });
    await streamer.finish(result.text);
  } catch (e) {
    log(`[slack] failed to process event for ${agentId}->${runAgentId}:`, e instanceof Error ? e.message : String(e));
    await slackApi("chat.postMessage", botToken, {
      channel: event.channel,
      text: `I hit an error while running the agent: ${e instanceof Error ? e.message : String(e)}`,
      thread_ts: event.thread_ts || event.ts,
      unfurl_links: false,
      unfurl_media: false,
    }).catch(() => {});
  }
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
const ocGlobalBus = new Set(); // SSE writers for opencode child events

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
    const modelId = process.env.GITHUB_COPILOT_MODEL || (process.env.LITELLM_API_BASE ? "claude-code-sonnet-4-6-converse" : "gpt-4o");
    return copilotRunTurn(cs, prompt, modelId);
  }
  if (harness === "codex") {
    const cs = codexSessions.get(sessionId);
    if (!cs) throw new Error(`callPromptAsync: codex session ${sessionId} not found`);
    return codexRunTurn(cs, prompt);
  }
  // opencode — send via HTTP to the child process
  // Include pinned model so the child doesn't fall back to anthropic/* (the boot_model
  // from /v1/models which resolves to an unavailable model on this account).
  const pinnedProvider = process.env.PROVIDER_NAME || "litellm";
  const pinnedModel = process.env.LITELLM_DEFAULT_MODEL || "anthropic/claude-sonnet-4-6";
  const sysPrompt = sessionSystemPrompt.get(sessionId);
  const effectivePrompt = sysPrompt && !ocSysPromptDelivered.has(sessionId)
    ? `${sysPrompt}\n\n---\n\n${prompt}`
    : prompt;
  if (sysPrompt && !ocSysPromptDelivered.has(sessionId)) ocSysPromptDelivered.add(sessionId);
  const body = JSON.stringify({
    parts: [{ type: "text", text: effectivePrompt }],
    model: { providerID: pinnedProvider, modelID: pinnedModel },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${UP}/session/${sessionId}/prompt_async`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`opencode child rejected prompt: HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
      },
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

// Best-effort human-readable label for the session that owns an inbox item —
// the session title if we have it in-process, else the harness/agent tag.
// Hoisted (function declaration) so the broadcaster below can use it even though
// some session Maps are declared further down; it only reads them at call time.
function sessionLabel(sid) {
  if (!sid) return null;
  const s = ccSessions.get(sid) || copilotSessions.get(sid) || codexSessions.get(sid);
  if (s?.title) return s.title;
  const agent = sessionAgent.get(sid);
  return agent || null;
}

// Broadcast a raw lifecycle event to every connected /event client (CLI + web
// UI) via the plugin SSE bus, in the { id, type, properties } envelope clients
// already parse.
function broadcastEvent(type, properties) {
  const envelope = { id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`, type, properties };
  const line = `data: ${JSON.stringify(envelope)}\n\n`;
  for (const cb of pluginGlobalBus) { try { cb(line); } catch {} }
}

// Wire the agent inbox: bridge approval/issue lifecycle to persistence + SSE.
wireInbox({ broadcast: broadcastEvent, sessionLabel });

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

// ── @github/copilot-sdk lazy init ────────────────────────────────────────────
// One CopilotClient per process, shared across all copilot sessions.
// The SDK wraps the Copilot CLI subprocess; mcpServers in createSession() wires
// the platform MCP into every copilot session so all harnesses see sandbox tools.
let _copilotClient = null;
let _copilotClientPromise = null;

async function getCopilotClient() {
  if (_copilotClient) return _copilotClient;
  if (_copilotClientPromise) return _copilotClientPromise;
  _copilotClientPromise = (async () => {
    let mod;
    try {
      mod = await import("@github/copilot-sdk");
    } catch (e) {
      throw new Error(`@github/copilot-sdk not installed: ${e.message}`);
    }
    const client = new mod.CopilotClient();
    await client.start();
    _copilotClient = client;
    _copilotClientPromise = null;
    log("@github/copilot-sdk client started");
    return client;
  })();
  return _copilotClientPromise;
}

// In-process state for github-copilot sessions.
const copilotSessions = new Map(); // id → {id, title, time, history, busSubscribers, sdkSession?}
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

// (Token cache removed — native auth now handled by @github/copilot-sdk CLI)

function copilotEmit(sessionId, type, props) {
  const ev = { id: `evt_${randomUUID().replace(/-/g,"").slice(0,20)}`, type, properties: { ...props, sessionID: sessionId } };
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  const s = copilotSessions.get(sessionId);
  if (s) for (const cb of s.busSubscribers) { try { cb(line); } catch {} }
  for (const cb of copilotGlobalBus) { try { cb(line); } catch {} }
}

// Returns { url, key, extraHeaders } for the chat completions endpoint.
// BYOK mode (LITELLM_API_BASE set): routes to LiteLLM proxy.
// Native mode (GITHUB_TOKEN set): exchanges GitHub token for a short-lived Copilot token.
let _copilotToken = null;
let _copilotTokenExpiry = 0;
const COPILOT_NATIVE_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "vscode/1.85.0",
  "Editor-Plugin-Version": "copilot-chat/0.12.0",
  "Openai-Organization": "github-copilot",
};
async function getCopilotEndpoint() {
  const byokBase = process.env.LITELLM_API_BASE;
  if (byokBase) {
    return { url: byokBase.replace(/\/+$/, "") + "/chat/completions", key: process.env.LITELLM_API_KEY || "", extraHeaders: {} };
  }
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

/**
 * Fetch all platform MCP tools and convert to OpenAI function-call format.
 * Runs in-process against handleMcpRequest — no HTTP round-trip, no latency.
 */
async function getPlatformMcpToolsAsOpenAI() {
  try {
    const resp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    return (resp?.result?.tools ?? []).map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  } catch { return []; }
}

/**
 * Run one copilot turn via raw chat/completions with ALL platform MCP tools injected.
 *
 * Tool routing: every tool_call is dispatched to handleMcpRequest() in-process.
 * No hardcoded tool names — any tool registered in mcp/tools.mjs is automatically
 * available (sandbox_provision, sandbox_execute, save_agent, request_human_approval…).
 *
 * Note: @github/copilot-sdk is installed and available, but its mcpServers option in
 * createSession() does not yet connect to HTTP MCP servers in the current CLI version.
 * This implementation uses raw chat/completions + in-process tool injection instead,
 * which works reliably across BYOK (LiteLLM) and native (GITHUB_TOKEN) modes.
 */
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
  const parts = [];

  copilotEmit(s.id, "message.updated", { info: { id: asstMsgId, role: "assistant", time: { created: startedAt } } });
  copilotEmit(s.id, "message.part.updated", { messageID: asstMsgId, part: { id: partID, messageID: asstMsgId, type: "text", text: "" } });

  const model = modelId || process.env.GITHUB_COPILOT_MODEL || (process.env.LITELLM_API_BASE ? "claude-code-sonnet-4-6-converse" : "gpt-4o");
  try {
    const endpoint = await getCopilotEndpoint();
    // Fetch all platform MCP tools dynamically (in-process, no HTTP round-trip)
    const tools = await getPlatformMcpToolsAsOpenAI();

    let loopMessages = [...messages];
    let toolCallsThisTurn = 0;
    const MAX_TOOL_LOOPS = 8;

    while (true) {
      const resp = await fetch(endpoint.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${endpoint.key}`, "Content-Type": "application/json", ...endpoint.extraHeaders },
        body: JSON.stringify({ model, messages: loopMessages, ...(tools.length ? { tools } : {}), stream: true }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Copilot API ${resp.status}: ${errText.slice(0, 300)}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const toolCallAccum = {};
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
            if (delta.content) {
              totalText += delta.content;
              copilotEmit(s.id, "message.part.delta", { messageID: asstMsgId, partID, field: "text", delta: delta.content });
            }
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
      if (pendingToolCalls.length === 0 || finishReason !== "tool_calls" || toolCallsThisTurn >= MAX_TOOL_LOOPS) break;

      const assistantMsg = {
        role: "assistant",
        content: totalText || null,
        tool_calls: pendingToolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.argumentsRaw } })),
      };
      loopMessages.push(assistantMsg);

      for (const tc of pendingToolCalls) {
        const toolPartId = `tool_${tc.id || randomUUID().replace(/-/g,"").slice(0,8)}`;
        let args = {};
        try { args = JSON.parse(tc.argumentsRaw); } catch {}
        const toolPart = { id: toolPartId, messageID: asstMsgId, type: "tool", tool: tc.name, callID: tc.id, state: { input: args, status: "running" } };
        parts.push(toolPart);
        copilotEmit(s.id, "message.part.updated", { messageID: asstMsgId, part: toolPart });

        let toolResult = "";
        try {
          log(`copilot tool call: ${tc.name}`);
          const mcpResp = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tc.name, arguments: args } });
          const resultContent = mcpResp?.result?.content;
          toolResult = Array.isArray(resultContent)
            ? resultContent.map(c => c.text ?? JSON.stringify(c)).join("\n")
            : JSON.stringify(mcpResp?.result ?? mcpResp);
          toolPart.state.status = "completed";
          toolPart.state.output = toolResult.slice(0, 2000);
        } catch (toolErr) {
          toolResult = `Tool error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
          toolPart.state.status = "error";
          toolPart.state.output = toolResult;
        }
        copilotEmit(s.id, "message.part.updated", { messageID: asstMsgId, part: toolPart });
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
  parts.push(textPart);
  const fullInfo = { id: asstMsgId, role: "assistant", time: { created: startedAt, completed: completedAt }, harness: "github-copilot", modelID: model, ...(lastError ? { error: lastError } : { finish: "stop" }) };
  s.history.push({ info: fullInfo, parts });
  appendMessage(s.id, { info: fullInfo, parts }, s.history.length - 1);
  s.time.updated = completedAt;
  copilotEmit(s.id, "message.updated", { info: fullInfo });
  copilotEmit(s.id, "session.idle", {});
  log(`copilot turn done id=${s.id} model=${model} chars=${totalText.length}`);
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
      "-c", `mcp_servers.platform.url="${PLATFORM_MCP_URL}?session=${encodeURIComponent(s.id)}"`,
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
      // The claude-code SDK ignores `system`; it appends extra system-prompt
      // text via `appendSystemPrompt`. This is how an agent's skills + system
      // prompt (incl. the memory agent_id note) actually reach the model.
      ...(s.systemPrompt ? { appendSystemPrompt: s.systemPrompt } : {}),
      // Session-scoped MCP URL so platform tools (approvals, file_issue) know
      // which session they're acting for.
      mcpServers: [{ type: "http", url: `${PLATFORM_MCP_URL}?session=${encodeURIComponent(s.id)}` }],
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

// Pull `name:` / `description:` out of a SKILL.md YAML frontmatter block.
// Handles inline values and folded/literal block scalars (`>`/`|`), where the
// value continues on following indented lines.
function parseSkillFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      // Block scalar: gather subsequent indented lines, join on spaces.
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      val = block.join(" ");
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }
    out[key] = val;
  }
  return out;
}

// List the skills available on this server (the shared ~/.claude/skills catalog).
// Returns [{ slug, name, description }] sorted by slug.
function listPlatformSkills() {
  let entries = [];
  try { entries = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true }); } catch { return []; }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const skillMd = path.join(SKILLS_ROOT, slug, "SKILL.md");
    let meta = {};
    try { meta = parseSkillFrontmatter(fs.readFileSync(skillMd, "utf8")); } catch { continue; }
    skills.push({ slug, name: meta.name || slug, description: meta.description || "" });
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

// Build a system-prompt note describing the skills attached to an agent so the
// model knows they exist and when to invoke them. Returns "" if none resolve.
function skillsPromptNote(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return "";
  const catalog = new Map(listPlatformSkills().map((s) => [s.slug, s]));
  const lines = [];
  for (const slug of slugs) {
    const s = catalog.get(slug);
    if (!s) continue;
    lines.push(`- ${s.slug}: ${s.description || s.name}`.trim());
  }
  if (!lines.length) return "";
  return `\n\nAvailable skills (invoke when relevant):\n${lines.join("\n")}`;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

function readBodyBuffer(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => res(Buffer.concat(chunks)));
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runShell(cmd, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${out}\n[exit ${code}]`.trim()));
    });
  });
}

function materializeAgentFileLocal(root, file) {
  const target = path.join(root, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (file.encoding === "base64") {
    fs.writeFileSync(target, Buffer.from(file.content, "base64"));
  } else {
    fs.writeFileSync(target, file.content, "utf8");
  }
}

function opencodeAgentWorkspaceRoot(agentId) {
  return path.join(process.env.OPENCODE_INLINE_WORKDIR || "/tmp", "agent-workspaces", agentId);
}

function materializeOpencodeAgentWorkspace(agentId, { includePersistNote = true } = {}) {
  const agentFiles = listAgentFilesWithContent(agentId);
  if (agentFiles.length === 0) return "";

  const localRoot = opencodeAgentWorkspaceRoot(agentId);
  fs.rmSync(localRoot, { recursive: true, force: true });
  fs.mkdirSync(localRoot, { recursive: true });
  for (const file of agentFiles) materializeAgentFileLocal(localRoot, file);

  const fileList = agentFiles.map((f) => `  - ${path.join(localRoot, f.path)}`).join("\n");
  return (
    `\n\n---\nLocal workspace root: ${localRoot}\n` +
    `Files written under the local workspace root:\n${fileList}\n` +
    (includePersistNote
      ? `Use the normal file tools against this local workspace. After editing any file, call persist_file\n` +
        `to save changes so they survive future runs.\n`
      : "") +
    `---`
  );
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

async function getOcMessages(ourSid) {
  const childSid = ocSidRemap.get(ourSid) ?? ourSid;
  return new Promise((resolve) => {
    http.get(`${UP}/session/${encodeURIComponent(childSid)}/message`, (r) => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => {
        try {
          const msgs = JSON.parse(d);
          resolve(Array.isArray(msgs) ? msgs : []);
        } catch {
          resolve([]);
        }
      });
    }).on("error", () => resolve([]));
  });
}

async function pollOpencodeRunCompletion({ runId, runSid, maxRuntimeMinutes, onDone }) {
  const deadline = Date.now() + Math.max(1, Number(maxRuntimeMinutes) || 30) * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    const messages = await getOcMessages(runSid);
    const lastAssistant = [...messages].reverse().find((m) => m?.info?.role === "assistant");
    const finish = lastAssistant?.info?.finish;
    if (finish === "stop") {
      try { await snapshotOcMessages(runSid); } catch {}
      updateAgentRun(runId, { status: "completed", finishedAt: Date.now() });
      onDone?.();
      return;
    }
    if (finish === "error") {
      updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: "opencode run failed" });
      onDone?.();
      return;
    }
  }
  updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: "agent run timed out" });
  onDone?.();
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
    // Distribute raw opencode event to any agent run listeners.
    if (ocGlobalBus.size > 0) {
      const fwd = line + "\n";
      for (const cb of ocGlobalBus) { try { cb(fwd); } catch {} }
    }
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
    cron_supported: true,
    manual_trigger: true,
  };

  let sandbox = null;
  if (process.env.LAP_PLATFORM_MODE) {
    sandbox = { provider: "lap-platform", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  } else if (process.env.E2B_API_KEY) {
    sandbox = { provider: "e2b", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  } else if (process.env.DAYTONA_API_KEY) {
    sandbox = { provider: "daytona", outbound_network: true, pip_install: true, npm_install: true, max_runtime_minutes: 30, persistent_storage: false };
  }

  const { error: sbError } = buildDirectProvider();
  const files = sbError
    ? { available: false, reason: "no sandbox provider configured" }
    : { available: true, ...FILE_LIMITS, sandbox_required: true };

  return {
    harnesses,
    mcp_servers,
    vault,
    scheduler,
    files,
    ...(sandbox && { sandbox }),
    agents: {
      create:   "POST /api/agents",
      list:     "GET /api/agents?owner_id={uid}",
      get:      "GET /api/agents/{id}",
      update:   "PATCH /api/agents/{id}",
      delete:   "DELETE /api/agents/{id}",
      trigger:  "POST /api/agents/{id}/run",
      pause:    "POST /api/agents/{id}/pause",
      resume:   "POST /api/agents/{id}/resume",
      runs:     "GET /api/agents/{id}/runs",
    },
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

  if (!isSlackIngressRoute(p) && !authOk(req, url)) {
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
    // Agents connect with ?session=<id> appended to the MCP URL so tools like
    // request_human_approval / file_issue can attribute the item to its session.
    const response = await handleMcpRequest(mcpBody, { session: url.searchParams.get("session") || null });
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

  // Agent inbox — approvals (live + history) and agent-filed issues. All routes
  // (/api/approvals*, /api/inbox*) live in inbox-service.mjs.
  if (await handleInboxRoute(req, res, url, { authOk, readBody })) return;

  if (p === "/agents" && req.method === "GET") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listSavedAgents()));
    return;
  }

  const agentRouteMatch = p.match(/^\/agents\/([^/]+)$/);
  if (agentRouteMatch && req.method === "GET") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const a = getSavedAgent(decodeURIComponent(agentRouteMatch[1]));
    if (!a) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(a));
    return;
  }

  if (agentRouteMatch && req.method === "DELETE") {
    if (!authOk(req, url)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    deleteSavedAgent(decodeURIComponent(agentRouteMatch[1]));
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

    const sessionTz = body.timezone || null;
    let systemPromptOverride = body.systemPrompt || null;

    let storedBaseAgent = null;
    let apiAgentForSession = null;
    if (!builtin) {
      // Resolve the agent name/id against BOTH stores: the save_agent MCP store
      // (system_prompt) and the /api/agents store (prompt). The UI creates
      // agents in the latter, so a single-store lookup 404s on UI agents.
      let savedAgent = null;
      try { savedAgent = getSavedAgent(agentParam); } catch {}
      let apiAgent = null;
      if (!savedAgent) { try { apiAgent = getAgent(agentParam); } catch {} }
      if (!savedAgent && !apiAgent) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown agent: ${agentParam}` }));
        return;
      }
      // The /api/agents store can attach DB-backed skills (skill_ids); compose
      // their full content into the system prompt so the model follows them.
      systemPromptOverride = savedAgent
        ? savedAgent.system_prompt + memoryPromptNote(savedAgent.id)
        : composeAgentSystem(
            apiAgent.system || apiAgent.prompt || "",
            getSkillsByIds(apiAgent.skill_ids || []),
            listSkills(),
          ) + memoryPromptNote(apiAgent.id);
      body.title = body.title || (savedAgent ? savedAgent.name : apiAgent.name);
      apiAgentForSession = apiAgent;
      // Honor the agent's base harness. The MCP store calls it base_agent; the
      // /api/agents store calls it harness ("claude-code" -> "cc"). Default to
      // opencode (always available) rather than cc, which needs the claude-code
      // SDK to be installed.
      const rawHarness = (savedAgent && savedAgent.base_agent) || (apiAgent && apiAgent.harness) || "opencode";
      storedBaseAgent = rawHarness === "claude-code" ? "cc" : rawHarness;
    }
    const resolvedAgent = builtin ?? storedBaseAgent ?? "cc";
    const sessionPlatformAgentId = apiAgentForSession?.id ?? null;

    if (apiAgentForSession && resolvedAgent === "opencode") {
      try {
        const workspaceNote = materializeOpencodeAgentWorkspace(apiAgentForSession.id);
        if (workspaceNote) systemPromptOverride = `${systemPromptOverride || ""}${workspaceNote}`;
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `local workspace setup failed: ${e.message}` }));
        return;
      }
    }

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
      persistSession({ id, harness: "github-copilot", title: s.title, createdAt: now, tz: sessionTz, agentId: sessionPlatformAgentId });
      log(`copilot session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "github-copilot", ...(sessionPlatformAgentId ? { agent_id: sessionPlatformAgentId } : {}) }));
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
      persistSession({ id, harness: "codex", title: s.title, createdAt: now, tz: sessionTz, agentId: sessionPlatformAgentId });
      log(`codex session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "codex", ...(sessionPlatformAgentId ? { agent_id: sessionPlatformAgentId } : {}) }));
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
      persistSession({ id, harness: "cc", title: s.title, createdAt: now, tz: sessionTz, agentId: sessionPlatformAgentId });
      log(`cc session created id=${id} title=${JSON.stringify(s.title)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, title: s.title, time: s.time, agent: "claude-code", ...(sessionPlatformAgentId ? { agent_id: sessionPlatformAgentId } : {}) }));
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
            if (systemPromptOverride) sessionSystemPrompt.set(parsed.id, systemPromptOverride);
            persistSession({ id: parsed.id, harness: "opencode", title: parsed.title || "New session", createdAt: Date.now(), tz: sessionTz, agentId: sessionPlatformAgentId });
            if (sessionPlatformAgentId) parsed.agent_id = sessionPlatformAgentId;
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
      const agentId = getSessionAgentId(s.id);
      return { ...s, agent: "opencode", ...(agentId ? { agent_id: agentId } : {}) };
    });
    // Merge in DB-persisted opencode sessions not currently known to the child.
    const liveOcIds = new Set(tagged.map(s => s.id));
    const dbOcExtra = loadOcSessions()
      .filter(r => !liveOcIds.has(r.id))
      .map(r => {
        sessionHarness.set(r.id, "opencode");
        return { id: r.id, title: r.title, time: { created: r.created_at, ...(r.updated_at ? { updated: r.updated_at } : {}) }, harness: "opencode", ...(r.agent_id ? { agent_id: r.agent_id } : {}) };
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
    const all = [...tagged, ...dbOcExtra, ...ccList, ...copilotList, ...codexList]
      .filter(s => s.id != null)
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
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
      const agentId = getSessionAgentId(sid);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "claude-code", ...(agentId ? { agent_id: agentId } : {}) }));
      return;
    }
    if (sessionAgent.get(sid) === "github-copilot") {
      const cs = copilotSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      const agentId = getSessionAgentId(sid);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "github-copilot", ...(agentId ? { agent_id: agentId } : {}) }));
      return;
    }
    if (sessionAgent.get(sid) === "codex") {
      const cs = codexSessions.get(sid);
      if (!cs) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
      const agentId = getSessionAgentId(sid);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: cs.id, title: cs.title, time: cs.time, agent: "codex", ...(agentId ? { agent_id: agentId } : {}) }));
      return;
    }
    // opencode: proxy, fall back to SQLite metadata when child doesn't know the session
    const ocReq = http.request(UP + p, { method: "GET" }, (ocRes) => {
      let d = ""; ocRes.on("data", c => d += c); ocRes.on("end", () => {
        if (ocRes.statusCode === 404) {
          const row = loadOcSessions().find(r => r.id === sid);
          if (row) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: row.id, title: row.title, time: { created: row.created_at, ...(row.updated_at ? { updated: row.updated_at } : {}) }, agent: "opencode", ...(row.agent_id ? { agent_id: row.agent_id } : {}) }));
            return;
          }
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        try {
          const obj = JSON.parse(d);
          const agentId = getSessionAgentId(sid);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...obj, agent: "opencode", ...(agentId ? { agent_id: agentId } : {}) }));
        }
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
        const modelId = body.model?.modelID ?? (process.env.GITHUB_COPILOT_MODEL || (process.env.LITELLM_API_BASE ? "claude-code-sonnet-4-6-converse" : "gpt-4o"));
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
        const _sysPrompt = sessionSystemPrompt.get(sid);
        if (_sysPrompt && !ocSysPromptDelivered.has(sid)) {
          try {
            const _b = JSON.parse(forwardBody);
            const _ut = (_b.parts || []).filter(pt => pt.type === "text").map(pt => pt.text).join("\n");
            _b.parts = [{ type: "text", text: `${_sysPrompt}\n\n---\n\n${_ut}` }];
            forwardBody = JSON.stringify(_b);
            ocSysPromptDelivered.add(sid);
          } catch {}
        }
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

  // ── Vault HTTP endpoints ──────────────────────────────────────────────────────
  const _vaultUserMatch = p.match(/^\/api\/vault\/([^/]+)$/);
  const _vaultKeyMatch  = p.match(/^\/api\/vault\/([^/]+)\/([^/]+)$/);

  if (p === "/api/vault/rotate-master-key" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const oldMasterKey = typeof body.old_master_key === "string" ? body.old_master_key : "";
    if (!oldMasterKey) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "old_master_key required" }));
      return;
    }
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    if (!vaultPlugin || !vaultPlugin.backend || typeof vaultPlugin.backend.rotateMasterKey !== "function") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vault rotation not available" }));
      return;
    }
    try {
      const result = await vaultPlugin.backend.rotateMasterKey(oldMasterKey);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result, failed: result.failed.map(f => f.key) }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

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
    // Also surface env vars so the UI shows them as set (values never sent to client)
    const vaultKeySet = new Set(keys.map(r => r.key));
    if (typeof vaultPlugin.backend.envFallbackKeys === "function") {
      for (const k of vaultPlugin.backend.envFallbackKeys(userId)) {
        if (!vaultKeySet.has(k)) {
          keys.push({ key: k, updated_at: 0, source: "env" });
        }
      }
    }
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

  // ── Skill CRUD routes ─────────────────────────────────────────────────────────
  // Skills are reusable markdown capability docs, attached to agents via skill_ids.
  const _skillIdMatch = p.match(/^\/api\/skills\/([^/]+)$/);
  const _skillsMatch  = p === "/api/skills";

  if (_skillsMatch && req.method === "POST") {
    const raw = await readBody(req);
    let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
    const { name, content, description = null, owner_id = null } = b;
    if (!name || !content) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "name and content required" }));
      return;
    }
    const skill = createSkill({ name, content, description, owner_id });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(skill));
    return;
  }

  if (_skillsMatch && req.method === "GET") {
    const ownerId = url.searchParams.get("owner_id");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skills: listSkills(ownerId || undefined) }));
    return;
  }

  if (_skillIdMatch && req.method === "GET") {
    const skill = getSkill(_skillIdMatch[1]);
    if (!skill) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(skill));
    return;
  }

  if (_skillIdMatch && req.method === "PATCH") {
    if (!getSkill(_skillIdMatch[1])) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    const raw = await readBody(req);
    let f = {}; try { f = JSON.parse(raw || "{}"); } catch {}
    updateSkill(_skillIdMatch[1], f);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(getSkill(_skillIdMatch[1])));
    return;
  }

  if (_skillIdMatch && req.method === "DELETE") {
    deleteSkill(_skillIdMatch[1]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Slack custom app callback/webhook endpoints ───────────────────────────────
  const _slackOauthCallbackMatch = p.match(/^\/host-oauth-callback\/([^/]+)$/);
  const _agentSlackEventsMatch = p.match(/^\/api\/agents\/([^/]+)\/slack\/events$/);
  const _agentSlackInteractivityMatch = p.match(/^\/api\/agents\/([^/]+)\/slack\/interactivity$/);

  if (_slackOauthCallbackMatch && req.method === "GET") {
    const providerId = decodeURIComponent(_slackOauthCallbackMatch[1]);
    const agentId = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const found = agentId
      ? getAgent(agentId)
      : listAgents().find((ag) => ag.config?.slack?.provider_id === providerId);
    let oauthOk = false;
    let oauthMessage = "Slack sent the OAuth callback to Lite Agents.";
    if (found) {
      const config = found.config && typeof found.config === "object" ? found.config : {};
      const slack = config.slack && typeof config.slack === "object" ? config.slack : {};
      const nextSlack = {
        ...slack,
        provider_id: providerId,
        slack_team_id: url.searchParams.get("team") || slack.slack_team_id || null,
      };
      if (code) {
        const vaultPlugin = pluginRegistry.getPlugin("vault");
        const clientSecretKey = slack.client_secret_key;
        const clientSecret = vaultPlugin?.backend && clientSecretKey
          ? await vaultPlugin.backend.get(`default:${clientSecretKey}`)
          : null;
        if (!slack.client_id || !clientSecret) {
          nextSlack.status = "oauth_failed";
          nextSlack.oauth_error = "missing_client_credentials";
          oauthMessage = "Slack OAuth failed because the app credentials are not saved.";
        } else {
          try {
            const redirectUri = `${externalOrigin(req)}/host-oauth-callback/${encodeURIComponent(providerId)}`;
            const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: slack.client_id,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
              }),
            });
            const tokenBody = await tokenRes.json().catch(() => ({}));
            if (tokenBody.ok && tokenBody.access_token) {
              const botTokenKey = `SLACK_${found.id}_BOT_TOKEN`;
              await vaultPlugin.backend.set(`default:${botTokenKey}`, tokenBody.access_token);
              nextSlack.status = "connected";
              nextSlack.oauth_error = null;
              nextSlack.bot_token_key = botTokenKey;
              nextSlack.slack_team_id = tokenBody.team?.id || nextSlack.slack_team_id || null;
              nextSlack.slack_team_name = tokenBody.team?.name || nextSlack.slack_team_name || null;
              nextSlack.bot_user_id = tokenBody.bot_user_id || nextSlack.bot_user_id || null;
              nextSlack.authed_user_id = tokenBody.authed_user?.id || nextSlack.authed_user_id || null;
              oauthOk = true;
              oauthMessage = `${found.name} is now connected to Lite Agents.`;
            } else {
              nextSlack.status = "oauth_failed";
              nextSlack.oauth_error = tokenBody.error || `http_${tokenRes.status}`;
              oauthMessage = `Slack OAuth failed: ${nextSlack.oauth_error}`;
            }
          } catch (e) {
            nextSlack.status = "oauth_failed";
            nextSlack.oauth_error = e instanceof Error ? e.message : String(e);
            oauthMessage = `Slack OAuth failed: ${nextSlack.oauth_error}`;
          }
        }
      } else {
        nextSlack.status = slack.status || "credentials_saved";
      }
      updateAgent(found.id, { config: { ...config, slack: nextSlack } });
    }
    const safeMessage = oauthMessage.replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
    const returnPath = found
      ? `/agents/?slack_agent=${encodeURIComponent(found.id)}&slack_status=${oauthOk ? "connected" : "failed"}`
      : "/agents/";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Slack connected</title>
    <meta http-equiv="refresh" content="1.5; url=${returnPath}" />
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef6fb; color: #0f172a; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(680px, calc(100vw - 48px)); border: 1px solid #dbe4ee; border-radius: 12px; background: #fff; padding: 48px; text-align: center; box-sizing: border-box; }
      h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; }
      p { margin: 0; color: #475569; font-size: 16px; line-height: 1.5; }
      a { color: #0f172a; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>${oauthOk ? "Authentication successful" : "Authentication failed"}</h1>
      <p>${found ? safeMessage : "Slack sent the OAuth callback to Lite Agents."}</p>
      <p>${oauthOk ? "Redirecting back to Lite Agents..." : "Redirecting back so you can check the saved Slack credentials."}</p>
      <p><a href="${returnPath}">Return now</a></p>
    </main>
    <script>
      setTimeout(() => { window.location.href = ${JSON.stringify(returnPath)}; }, 1200);
    </script>
  </body>
</html>`);
    return;
  }

  if (_agentSlackEventsMatch && req.method === "POST") {
    const agentId = decodeURIComponent(_agentSlackEventsMatch[1]);
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const agentDef = getAgent(agentId);
    const slack = agentDef?.config?.slack && typeof agentDef.config.slack === "object" ? agentDef.config.slack : {};
    const vaultPlugin = pluginRegistry.getPlugin("vault");
    const signingSecret = vaultPlugin?.backend && slack.signing_secret_key
      ? await vaultPlugin.backend.get(`default:${slack.signing_secret_key}`)
      : null;
    if (!verifySlackSignature(req, raw, signingSecret)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_slack_signature" }));
      return;
    }
    if (body.challenge) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }
    if (body.event_id) {
      if (slackEventIds.has(body.event_id)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, duplicate: true }));
        return;
      }
      slackEventIds.add(body.event_id);
      setTimeout(() => slackEventIds.delete(body.event_id), 10 * 60 * 1000).unref?.();
    }
    setImmediate(() => {
      handleSlackEventAsync(agentId, body).catch((e) => {
        log(`[slack] async handler failed for ${agentId}:`, e instanceof Error ? e.message : String(e));
      });
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (_agentSlackInteractivityMatch && req.method === "POST") {
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
  const _agentMemoryKeyMatch = p.match(/^\/api\/agents\/([^/]+)\/memory\/(.+)$/);
  const _agentMemoryMatch    = p.match(/^\/api\/agents\/([^/]+)\/memory$/);
  const _agentIdMatch      = p.match(/^\/api\/agents\/([^/]+)$/);
  const _agentsMatch       = p === "/api/agents";

  // ── Agent memory ──────────────────────────────────────────────────────────────
  // The same per-agent key→value store the memory_* MCP tools read & write, so
  // the UI can show (and curate) what an agent has remembered.
  if (_agentMemoryMatch && req.method === "GET") {
    const agentId = _agentMemoryMatch[1];
    if (!getAgent(agentId)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ memories: listMemory(agentId) }));
    return;
  }

  if (_agentMemoryMatch && req.method === "POST") {
    const agentId = _agentMemoryMatch[1];
    if (!getAgent(agentId)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
    const raw = await readBody(req);
    let b = {}; try { b = JSON.parse(raw || "{}"); } catch {}
    const { key, value, always_on } = b;
    if (!key || value == null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "key and value required" }));
      return;
    }
    const row = storeMemory({
      agentId,
      key: String(key),
      value: String(value),
      alwaysOn: typeof always_on === "boolean" ? always_on : undefined,
    });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(row));
    return;
  }

  if (_agentMemoryKeyMatch && req.method === "DELETE") {
    const agentId = _agentMemoryKeyMatch[1];
    const key = decodeURIComponent(_agentMemoryKeyMatch[2]);
    const deleted = deleteMemory(agentId, key);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted }));
    return;
  }

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
      skill_ids = [],
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
      skill_ids: Array.isArray(skill_ids) ? skill_ids : [],
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
    deleteAllMemory(agentId);   // an agent's memory dies with it
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

    // Wire up cron loop if agent has a schedule but no loop yet.
    if (existing.cron && !existing.loop_id) {
      try {
        const tz = existing.timezone || "UTC";
        const job = new Cron(existing.cron, { timezone: tz, paused: true });
        const nextRun = job.nextRun();
        const nextRunAt = nextRun ? nextRun.getTime() : Date.now() + 60_000;
        const agentPrompt = existing.prompt || existing.system || "";
        const loop = createLoop({
          sessionId: existing.session_id,
          prompt: agentPrompt,
          cronExpr: existing.cron,
          tz,
          nextRunAt,
        });
        setAgentLoop(agentId, loop.id);
        log(`[resume] created loop ${loop.id} for agent ${agentId} cron=${existing.cron} tz=${tz}`);
      } catch (e) {
        log(`[resume] failed to create loop for agent ${agentId}:`, e.message);
      }
    }

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
    const promptOverride = typeof body.prompt === "string" ? body.prompt : null;
    const requestedSessionId = typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim()
      : null;

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

    // Compose the effective system prompt: skills catalog + attached skills +
    // the agent's own system. The user message is the agent's `prompt` (task).
    const attachedSkills = getSkillsByIds(agentDef.skill_ids || []);
    const allSkills = listSkills();
    let effectiveSystem = composeAgentSystem(agentDef.system, attachedSkills, allSkills) + memoryPromptNote(agentId);

    // Resolve prompt templates ({{vault.X}} and {{config.X}}) in both the task
    // prompt and the composed system prompt.
    const mergedConfig = Object.assign({}, agentDef.config || {}, configOverrides);
    let resolvedPrompt = (promptOverride && promptOverride.trim())
      ? promptOverride
      : (agentDef.prompt && agentDef.prompt.trim()) ? agentDef.prompt : "Proceed with your task.";
    try {
      if (vaultPlugin && vaultPlugin.backend) {
        const uid = agentDef.owner_id || "default";
        resolvedPrompt = await resolveTemplates(resolvedPrompt, uid, mergedConfig, vaultPlugin.backend);
        effectiveSystem = await resolveTemplates(effectiveSystem, uid, mergedConfig, vaultPlugin.backend);
      }
    } catch (e) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }

    // Attached DB skills are composed into effectiveSystem above (full content),
    // applied to the run session as its system prompt below.

    // Create ephemeral session for this run using the agent's configured harness
    const runHarness = agentDef.harness === "claude-code" ? "cc" : agentDef.harness === "github-copilot" ? "github-copilot" : agentDef.harness === "codex" ? "codex" : "opencode";
    if (runHarness === "cc" && !ccQuery) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "claude-code SDK not available" }));
      return;
    }
    let runSid;
    const runNow = Date.now();
    let reusedRunSession = false;
    if (requestedSessionId && runHarness === "opencode") {
      runSid = requestedSessionId;
      reusedRunSession = true;
      sessionAgent.set(runSid, "opencode");
      sessionHarness.set(runSid, "opencode");
      if (effectiveSystem) sessionSystemPrompt.set(runSid, effectiveSystem);
    } else if (runHarness === "opencode") {
      // Create the session in the opencode child first so prompt_async finds it.
      try {
        const ocSessResp = await new Promise((resolve, reject) => {
          let data = "";
          const r = http.request(`${UP}/session`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
            res.on("data", c => data += c);
            res.on("end", () => {
              try {
                const parsed = JSON.parse(data);
                if (!parsed.id || (parsed.success === false)) {
                  const msg = parsed.error?.[0]?.message ?? parsed.error ?? "session creation rejected";
                  reject(new Error(`opencode POST /session failed: ${msg}`));
                } else {
                  resolve(parsed);
                }
              } catch { reject(new Error("bad json from child")); }
            });
          });
          r.on("error", reject);
          // Don't pass model at session creation — opencode rejects all model formats.
          // The model is applied by the adapter's FORCE_MODEL logic when the prompt fires.
          r.end(JSON.stringify({ title: `agent-run-${agentId}` }));
        });
        runSid = ocSessResp.id;
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `failed to create opencode session: ${e.message}` }));
        return;
      }
      sessionAgent.set(runSid, "opencode");
      sessionHarness.set(runSid, "opencode");
      // opencode applies the system prompt via the sessionSystemPrompt map.
      if (effectiveSystem) sessionSystemPrompt.set(runSid, effectiveSystem);
    } else {
      runSid = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      ccSessions.set(runSid, {
        id: runSid, title: `agent-run-${agentId}`,
        time: { created: runNow }, harness: agentDef.harness || "claude-code",
        sdkSessionId: null, abortController: null, history: [], busSubscribers: new Set(),
        systemPrompt: effectiveSystem || null,   // composed DB skills + agent.system
      });
      sessionAgent.set(runSid, runHarness);
      sessionHarness.set(runSid, runHarness);
    }
    if (!reusedRunSession) {
      persistSession({ id: runSid, harness: runHarness, title: `agent-run-${agentId}`, createdAt: runNow, agentId });
    } else {
      persistSession({ id: runSid, harness: runHarness, title: `agent-run-${agentId}`, createdAt: runNow, agentId });
    }

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
          const { provider: _sbP, sandboxId: _sbId } = getRunSandbox(runId);
          if (_sbP && _sbId) _sbP.terminate(_sbId).catch(() => {});
          ccGlobalBus.delete(runEventListener);
          pluginGlobalBus.delete(runEventListener);
          ocGlobalBus.delete(runEventListener);
        } else if (evt.type === "session.error") {
          const errMsg = (evt.properties && evt.properties.error && evt.properties.error.message) || "unknown error";
          updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: errMsg });
          const { provider: _sbP2, sandboxId: _sbId2 } = getRunSandbox(runId);
          if (_sbP2 && _sbId2) _sbP2.terminate(_sbId2).catch(() => {});
          if (agentDef.on_failure === "pause_and_notify") {
            updateAgent(agentId, { status: "paused" });
          }
          ccGlobalBus.delete(runEventListener);
          pluginGlobalBus.delete(runEventListener);
          ocGlobalBus.delete(runEventListener);
        }
      } catch {}
    };
    ccGlobalBus.add(runEventListener);
    pluginGlobalBus.add(runEventListener);
    if (runHarness === "opencode") ocGlobalBus.add(runEventListener);

    // Always inject agent identity so the agent can call persist_file
    resolvedPrompt +=
      `\n\n---\nAgent context:\n  agent_id: ${agentId}\n` +
      `  run_id: ${runId}\n` +
      `  To persist files you create in the sandbox back to the platform, call the\n` +
      `  persist_file MCP tool with your agent_id and the file path + content.\n---`;

    const agentFiles = listAgentFilesWithContent(agentId);
    const setupCommands = Array.isArray(agentDef.setup_commands) ? agentDef.setup_commands.filter(Boolean) : [];
    if (runHarness === "opencode" && (agentFiles.length > 0 || setupCommands.length > 0)) {
      try {
        const localRoot = opencodeAgentWorkspaceRoot(agentId);
        fs.mkdirSync(localRoot, { recursive: true });
        const workspaceNote = agentFiles.length
          ? materializeOpencodeAgentWorkspace(agentId, { includePersistNote: false })
          : `\n\n---\nLocal workspace root: ${localRoot}\n`;
        for (const cmd of setupCommands) await runShell(cmd, { cwd: localRoot });
        resolvedPrompt += workspaceNote.replace(/\n---$/, "") +
          (setupCommands.length ? `Setup commands already ran in ${localRoot}:\n${setupCommands.map(c => `  - ${c}`).join("\n")}\n` : "") +
          `Use the normal file tools against this local workspace. After editing any file, call persist_file\n` +
          `to save changes so they survive future runs.\n---`;
      } catch (e) {
        updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: `local workspace setup failed: ${e.message}` });
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `local workspace setup failed: ${e.message}` }));
        return;
      }
    }

    // Provision sandbox and write agent files/setup commands if any exist.
    if (runHarness !== "opencode" && (agentFiles.length > 0 || setupCommands.length > 0)) {
      const { provider: sbProvider, error: sbError } = buildDirectProvider();
      if (sbError) {
        updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: `sandbox not configured: ${sbError}` });
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `sandbox not configured: ${sbError}` }));
        return;
      }
      try {
        const { id: sbId } = await sbProvider.create(`agent-run-${runId}`);
        setRunSandbox(runId, sbProvider, sbId);
        updateAgentRun(runId, { sandboxId: sbId });
        for (const file of agentFiles) {
          const target = `${SANDBOX_WORKSPACE_DIR}/${file.path}`;
          const dir = target.split("/").slice(0, -1).join("/") || SANDBOX_WORKSPACE_DIR;
          await sbProvider.execute(sbId, `mkdir -p ${shellQuote(dir)}`);
          if (file.encoding === "base64") {
            await sbProvider.execute(sbId, `printf %s ${shellQuote(file.content)} | base64 -d > ${shellQuote(target)}`);
          } else {
            await sbProvider.writeFile(sbId, target, file.content);
          }
        }
        for (const cmd of setupCommands) {
          const output = await sbProvider.execute(sbId, `cd ${shellQuote(SANDBOX_WORKSPACE_DIR)} && ${cmd}`);
          if (/\[exit [1-9]\d*\]\s*$/.test(output.trim())) {
            throw new Error(`setup command failed: ${cmd}\n${output}`);
          }
        }
        const fileList = agentFiles.map(f => `  - ${SANDBOX_WORKSPACE_DIR}/${f.path}`).join("\n");
        resolvedPrompt +=
          `\n\n---\nSandbox provisioned (${sbProvider.providerName}). ID: ${sbId}.\n` +
          `Workspace root: ${SANDBOX_WORKSPACE_DIR}\n` +
          (agentFiles.length ? `Files written under the workspace root:\n${fileList}\n` : "") +
          (setupCommands.length ? `Setup commands already ran in ${SANDBOX_WORKSPACE_DIR}:\n${setupCommands.map(c => `  - ${c}`).join("\n")}\n` : "") +
          `Use sandbox tools to execute them. After editing any file, call persist_file\n` +
          `to save changes so they survive sandbox teardown.\n---`;
      } catch (e) {
        updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: `sandbox setup failed: ${e.message}` });
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `sandbox setup failed: ${e.message}` }));
        return;
      }
    }

    // Fire prompt async — non-blocking
    callPromptAsync(runSid, resolvedPrompt).catch((e) => {
      log(`run ${runId} error: ${e.message}`);
      updateAgentRun(runId, { status: "failed", finishedAt: Date.now(), error: e.message });
      ccGlobalBus.delete(runEventListener);
      pluginGlobalBus.delete(runEventListener);
      ocGlobalBus.delete(runEventListener);
    });
    if (runHarness === "opencode") {
      pollOpencodeRunCompletion({
        runId,
        runSid,
        maxRuntimeMinutes: agentDef.max_runtime_minutes,
        onDone: () => {
          ccGlobalBus.delete(runEventListener);
          pluginGlobalBus.delete(runEventListener);
          ocGlobalBus.delete(runEventListener);
        },
      }).catch((e) => {
        log(`run ${runId} completion poll error: ${e.message}`);
      });
    }

    const host = req.headers.host || "localhost";
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({
      run_id: runId,
      agent_id: agentId,
      session_id: runSid,
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

  // ── Agent file endpoints ──────────────────────────────────────────────────────
  // PUT /api/agents/:id/files/* — upsert a file (wildcard path after /files/)
  // GET /api/agents/:id/files   — list files (no content)
  // GET /api/agents/:id/files/* — fetch single file with content
  // DELETE /api/agents/:id/files/* — delete single file
  // DELETE /api/agents/:id/files   — delete all files for agent
  const _agentFilePrefixMatch = p.match(/^\/api\/agents\/([^/]+)\/files(\/.*)?$/);
  if (_agentFilePrefixMatch) {
    const agentId  = _agentFilePrefixMatch[1];
    const fileSuffix = _agentFilePrefixMatch[2]; // "/path/to/file.py" or undefined
    const filePath = fileSuffix ? decodeURIComponent(fileSuffix.slice(1)) : null; // strip leading /

    const agentExists = getAgent(agentId);
    if (!agentExists) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "agent not found" }));
      return;
    }

    if (req.method === "PUT" && filePath) {
      const rawBuffer = await readBodyBuffer(req);
      const raw = rawBuffer.toString("utf8");
      let content;
      let encoding = isBinaryAgentFile(filePath) ? "base64" : "utf8";
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.content_base64 === "string") {
            content = parsed.content_base64;
            encoding = "base64";
          } else {
            content = parsed.content;
            encoding = parsed.encoding === "base64" ? "base64" : "utf8";
          }
        } catch {}
      }
      if (content === undefined) {
        content = encoding === "base64" ? rawBuffer.toString("base64") : raw;
      }
      if (!content && content !== "") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "content required" }));
        return;
      }
      try {
        const file = upsertAgentFile(agentId, filePath, content, { encoding });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: file.path, encoding: file.encoding, size_bytes: file.size_bytes }));
      } catch (e) {
        res.writeHead(e.status || 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === "GET" && !filePath) {
      const files = listAgentFiles(agentId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files }));
      return;
    }

    if (req.method === "GET" && filePath) {
      const file = getAgentFile(agentId, filePath);
      if (!file) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "file not found" }));
        return;
      }
      if (file.encoding === "base64") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(file.content, "base64"));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(file.content);
      return;
    }

    if (req.method === "DELETE" && filePath) {
      deleteAgentFile(agentId, filePath);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "DELETE" && !filePath) {
      deleteAllAgentFiles(agentId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
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
  currentChild = child;
  child.on("exit", (code) => { currentChild = null; log(`opencode serve exited (${code}) — shutting down`); process.exit(code ?? 1); });
}

function killChild(signal) {
  if (currentChild) { try { currentChild.kill(signal || "SIGTERM"); } catch {} }
}

process.on("SIGTERM", () => { killChild("SIGTERM"); process.exit(0); });
process.on("SIGINT",  () => { killChild("SIGTERM"); process.exit(0); });
process.on("exit",    () => { killChild("SIGTERM"); });

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
