import type { HarnessMessage, OpencodeSession } from "./types";

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

export async function createSession(title?: string, harness?: "opencode" | "claude-code" | "github-copilot"): Promise<OpencodeSession> {
  const res = await req("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, ...(harness ? { harness } : {}) }),
  });
  return jsonOrThrow<OpencodeSession>(res);
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await req(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* swallow */
  }
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
