// Human-in-the-loop approval store.
//
// The agent decides WHEN to ask for approval — its system prompt tells it to
// call the `request_human_approval` tool before sensitive actions. That tool
// parks the request here and blocks until a human Accepts (optionally with
// edited arguments) or Rejects (optionally with feedback for the agent).
// Pending approvals are surfaced to clients (CLI / web UI) via a broadcaster
// and resolved through the harness's HTTP API.
//
// There is intentionally no server-side "which tools are gated" policy — the
// gating decision lives in the agent's prompt, not in config.
//
// ESM module — no external deps, only node:crypto.

import { randomUUID } from "node:crypto";

/** @typedef {{ id: string, tool: string, args: object, createdAt: number, resolve: (o: object) => void, timer: any }} PendingEntry */

/** @type {Map<string, PendingEntry>} */
const pending = new Map();

/** @type {((event: object) => void) | null} */
let broadcaster = null;

// Default: 30 minutes. A human who never answers shouldn't wedge the agent forever.
const DEFAULT_TIMEOUT_MS = Number(process.env.HITL_APPROVAL_TIMEOUT_MS) || 30 * 60 * 1000;

/**
 * Register a function that pushes approval lifecycle events to connected clients.
 * @param {(event: object) => void} fn
 */
export function setApprovalBroadcaster(fn) {
  broadcaster = fn;
}

function emit(type, props) {
  if (!broadcaster) return;
  try {
    broadcaster({ type, ...props });
  } catch (err) {
    console.error("[approvals] broadcaster error:", err);
  }
}

/**
 * Block until a human resolves the approval.
 * @param {string} tool
 * @param {object} args
 * @param {{ timeoutMs?: number, unref?: boolean }} [opts]
 * @returns {Promise<{ decision: "accept", args: object } | { decision: "reject", feedback: string }>}
 */
export function requestApproval(tool, args, { timeoutMs = DEFAULT_TIMEOUT_MS, unref = true } = {}) {
  const id = `appr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const createdAt = Date.now();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const feedback = "Approval request timed out — no human responded in time.";
      emit("tool.approval.resolved", { id, tool, decision: "reject", feedback });
      resolve({ decision: "reject", feedback });
    }, timeoutMs);
    // Don't let a pending approval keep the process alive on its own.
    if (unref && timer.unref) timer.unref();

    const entry = {
      id,
      tool,
      args,
      createdAt,
      timer,
      resolve: (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
    };
    pending.set(id, entry);
    emit("tool.approval.requested", { id, tool, arguments: args, createdAt });
  });
}

/** Public view of a pending entry (no internal handles). */
function publicView(e) {
  return { id: e.id, tool: e.tool, arguments: e.args, createdAt: e.createdAt };
}

/** @returns {Array<{ id: string, tool: string, arguments: object, createdAt: number }>} */
export function listPending() {
  return [...pending.values()].map(publicView);
}

export function getPending(id) {
  const e = pending.get(id);
  return e ? publicView(e) : null;
}

/**
 * Accept a pending approval, optionally overriding the tool arguments.
 * @param {string} id
 * @param {object} [editedArgs]  if provided (an object), replaces the original args
 * @returns {boolean} true if a pending approval was found and resolved
 */
export function acceptApproval(id, editedArgs) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  const args = editedArgs && typeof editedArgs === "object" && !Array.isArray(editedArgs) ? editedArgs : entry.args;
  emit("tool.approval.resolved", { id, tool: entry.tool, decision: "accept" });
  entry.resolve({ decision: "accept", args });
  return true;
}

/**
 * Reject a pending approval. The feedback is returned to the agent so it can
 * correct course ("Or tell the agent what it did wrong").
 * @param {string} id
 * @param {string} [feedback]
 * @returns {boolean} true if a pending approval was found and resolved
 */
export function rejectApproval(id, feedback) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  const fb = feedback || "";
  emit("tool.approval.resolved", { id, tool: entry.tool, decision: "reject", feedback: fb });
  entry.resolve({ decision: "reject", feedback: fb });
  return true;
}

/** Test helper — clear all pending state without resolving. */
export function _reset() {
  for (const e of pending.values()) {
    try {
      clearTimeout(e.timer);
    } catch {}
  }
  pending.clear();
  broadcaster = null;
}
