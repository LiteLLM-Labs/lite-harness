import type { Agent, HarnessMessage, OpencodeSession, Skill } from "./types";

const BASE = "";
const MASTER_KEY_STORAGE = "lite-harness-master-key";

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

export function getStoredMasterKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(MASTER_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setStoredMasterKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(MASTER_KEY_STORAGE, key);
  } catch {
    /* noop */
  }
}

export function clearStoredMasterKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(MASTER_KEY_STORAGE);
  } catch {
    /* noop */
  }
}

function withAuth(init?: RequestInit): RequestInit {
  const key = getStoredMasterKey();
  if (!key) return { cache: "no-store", ...init };
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
  return { cache: "no-store", ...init, headers };
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(BASE + path, withAuth(init));
  if (res.status === 401 && typeof window !== "undefined") {
    clearStoredMasterKey();
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    if (!window.location.pathname.startsWith("/login")) {
      window.location.replace(`/login/?next=${next}`);
    }
  }
  return res;
}

export async function whoami(): Promise<void> {
  const res = await req("/whoami");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body);
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export async function listSessions(): Promise<OpencodeSession[]> {
  const res = await req("/session");
  const list = await jsonOrThrow<OpencodeSession[]>(res);
  return [...list].sort(
    (a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0),
  );
}

export async function createSession(title?: string, agent?: string): Promise<OpencodeSession> {
  const res = await req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, ...(agent ? { agent } : {}) }),
  });
  return jsonOrThrow<OpencodeSession>(res);
}

export async function listAgents(): Promise<Agent[]> {
  const res = await req("/api/agents");
  const data = await jsonOrThrow<{ agents: Agent[] }>(res);
  return data.agents;
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await req(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* swallow */
  }
}

export interface LiteLLMHealth {
  ok: boolean;
  modelCount?: number;
  status?: number;
  error?: string;
  base?: string;
  modelsUrl?: string;
}

export async function testLiteLLMConnection(): Promise<LiteLLMHealth> {
  const res = await req("/_litellm/health");
  return jsonOrThrow<LiteLLMHealth>(res);
}

export async function getSession(id: string): Promise<OpencodeSession> {
  const res = await req(`/session/${encodeURIComponent(id)}`);
  return jsonOrThrow<OpencodeSession>(res);
}

export async function getMessages(sid: string): Promise<HarnessMessage[]> {
  const res = await req(`/session/${encodeURIComponent(sid)}/message`);
  return jsonOrThrow<HarnessMessage[]>(res);
}

export async function sendMessage(opts: {
  sessionId: string;
  text: string;
  model: string;
}): Promise<void> {
  const res = await req(
    `/session/${encodeURIComponent(opts.sessionId)}/prompt_async`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "litellm", modelID: opts.model },
        parts: [{ type: "text", text: opts.text }],
      }),
    },
  );
  if (res.status === 204) return;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body);
  }
}

export async function abortSession(id: string): Promise<void> {
  await req(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" });
}

export async function listModels(): Promise<string[]> {
  const res = await req("/v1/models");
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const items: Array<{ id: string }> = data?.data ?? [];
  return items.map((m) => m.id).filter(Boolean);
}

export interface PendingApproval {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  createdAt: number;
}

export async function listApprovals(): Promise<PendingApproval[]> {
  const res = await req("/api/approvals");
  const data = await jsonOrThrow<{ approvals: PendingApproval[] }>(res);
  return data.approvals ?? [];
}

export async function acceptApproval(
  id: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const res = await req(`/api/approvals/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ? { arguments: args } : {}),
  });
  await jsonOrThrow(res);
}

export async function rejectApproval(id: string, feedback?: string): Promise<void> {
  const res = await req(`/api/approvals/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feedback ? { feedback } : {}),
  });
  await jsonOrThrow(res);
}

// ── Agent inbox (/api/inbox) ────────────────────────────────────────────────
// Unified list of human-in-the-loop approvals (kind="approval") an agent is
// blocked on, plus informational issues an agent filed (kind="issue").

export type InboxKind = "approval" | "issue";
export type InboxStatus = "pending" | "accepted" | "rejected" | "open" | "resolved";
export type InboxFilter = "attention" | "completed" | "all";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  sessionId: string | null;
  agent: string | null;
  body: string | null;
  /** Approval tool arguments (editable fields) — present for kind="approval". */
  args?: Record<string, unknown>;
  status: InboxStatus;
  feedback: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export async function listInbox(filter: InboxFilter = "all"): Promise<InboxItem[]> {
  const res = await req(`/api/inbox?filter=${encodeURIComponent(filter)}`);
  const data = await jsonOrThrow<{ items: InboxItem[] }>(res);
  return data.items ?? [];
}

/** Mark an inbox issue done. */
export async function resolveInboxItem(id: string, note?: string): Promise<void> {
  const res = await req(`/api/inbox/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(note ? { note } : {}),
  });
  await jsonOrThrow(res);
}

// ── Integrations / vault ──────────────────────────────────────────────────────
// API keys are stored in the harness's encrypted vault via /api/vault/:userId.
// When the backend vault is unreachable (e.g. running the UI standalone via
// `next dev`), we transparently fall back to sessionStorage so the flow still
// works. Per project policy, secrets only ever touch sessionStorage — never
// localStorage.

const VAULT_USER = "default";
const VAULT_FALLBACK_PREFIX = "lite-harness-integration:";

function fallbackSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(VAULT_FALLBACK_PREFIX + key, value);
  } catch {
    /* noop */
  }
}

function fallbackDelete(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(VAULT_FALLBACK_PREFIX + key);
  } catch {
    /* noop */
  }
}

function fallbackList(): string[] {
  if (typeof window === "undefined") return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k?.startsWith(VAULT_FALLBACK_PREFIX)) {
        keys.push(k.slice(VAULT_FALLBACK_PREFIX.length));
      }
    }
  } catch {
    /* noop */
  }
  return keys;
}

/** Store an integration's API key. Returns the storage backend that took it. */
export async function saveIntegrationKey(
  envKey: string,
  value: string,
): Promise<"vault" | "session"> {
  try {
    const res = await req(`/api/vault/${VAULT_USER}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: envKey, value }),
    });
    if (res.ok) return "vault";
  } catch {
    /* fall through to sessionStorage */
  }
  fallbackSet(envKey, value);
  return "session";
}

/** Remove a stored integration key from both vault and sessionStorage. */
export async function deleteIntegrationKey(envKey: string): Promise<void> {
  try {
    await req(`/api/vault/${VAULT_USER}/${encodeURIComponent(envKey)}`, {
      method: "DELETE",
    });
  } catch {
    /* noop */
  }
  fallbackDelete(envKey);
}

/** List the env-key names that currently have a stored value. */
export async function listIntegrationKeys(): Promise<string[]> {
  const keys = new Set<string>(fallbackList());
  try {
    const res = await req(`/api/vault/${VAULT_USER}`);
    if (res.ok) {
      const data = (await res.json()) as { keys?: { key: string }[] };
      for (const k of data.keys ?? []) keys.add(k.key);
    }
  } catch {
    /* vault unavailable — sessionStorage only */
  }
  return [...keys];
}

export function subscribeEvents(opts: {
  sessionId: string;
  onEvent: (ev: unknown) => void;
  onError?: (err: unknown) => void;
}): () => void {
  let es: EventSource | null = null;
  try {
    const key = getStoredMasterKey();
    const qs = key ? `?key=${encodeURIComponent(key)}` : "";
    es = new EventSource(BASE + "/event" + qs);
  } catch (e) {
    opts.onError?.(e);
    return () => {};
  }
  es.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      const sid =
        (data?.properties?.sessionID as string | undefined) ??
        (data?.properties?.info?.sessionID as string | undefined);
      if (!sid || sid === opts.sessionId) opts.onEvent(data);
    } catch (e) {
      opts.onError?.(e);
    }
  };
  es.onerror = (e) => opts.onError?.(e);
  return () => {
    try {
      es?.close();
    } catch {
      /* noop */
    }
  };
}

// ── Agent CRUD (/api/agents) ────────────────────────────────────────────────
export async function createAgent(
  input: { name: string; owner_id: string } & Partial<Agent>,
): Promise<Agent> {
  const res = await req("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<Agent>(res);
}

export async function updateAgent(id: string, fields: Partial<Agent>): Promise<Agent> {
  const res = await req(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  return jsonOrThrow<Agent>(res);
}

export async function deleteAgent(id: string): Promise<void> {
  await req(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Skills catalog (/api/skills) ────────────────────────────────────────────
export async function listSkills(): Promise<Skill[]> {
  const res = await req("/api/skills");
  const data = await jsonOrThrow<{ skills: Skill[] }>(res);
  return data.skills;
}
