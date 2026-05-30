/**
 * Agent-inbox service.
 *
 * Owns the entire human-in-the-loop surface so the inline adapter stays a thin
 * dispatcher:
 *   1. Persistence wiring — bridges the in-memory approval broadcaster
 *      (mcp/approvals.mjs) and the issue sink (mcp/issues.mjs) to durable rows
 *      in inbox-store.mjs, and mirrors every lifecycle event onto the SSE bus.
 *   2. HTTP routes — GET /api/approvals, accept/reject, GET /api/inbox, and
 *      issue resolve.
 *
 * The adapter calls wireInbox() once at startup and handleInboxRoute() per
 * request; it injects how to broadcast and how to label a session, keeping this
 * module free of the adapter's session Maps and SSE internals.
 */

import { setApprovalBroadcaster, listPending, acceptApproval, rejectApproval } from "../mcp/approvals.mjs";
import { setIssueSink } from "../mcp/issues.mjs";
import {
  recordApprovalRequested,
  recordApprovalResolved,
  recordIssue,
  resolveItem,
  listItems,
} from "./inbox-store.mjs";

/** @type {(type: string, properties: object) => void} */
let broadcast = () => {};
/** @type {(sessionId: string | null) => string | null} */
let sessionLabel = () => null;

/**
 * Bridge approval + issue lifecycle into persistence and the SSE bus. Call once.
 *
 * @param {{ broadcast: (type: string, properties: object) => void,
 *           sessionLabel: (sessionId: string|null) => string|null }} deps
 */
export function wireInbox(deps) {
  broadcast = deps.broadcast;
  sessionLabel = deps.sessionLabel;

  // Persist approvals as they're requested/resolved, then relay to clients so
  // the inbox shows live pending items AND resolved history.
  setApprovalBroadcaster((event) => {
    const { type, ...rest } = event;
    if (type === "tool.approval.requested") {
      recordApprovalRequested({
        id: rest.id,
        tool: rest.tool,
        args: rest.arguments,
        sessionId: rest.sessionID ?? null,
        agent: sessionLabel(rest.sessionID),
        createdAt: rest.createdAt ?? Date.now(),
      });
    } else if (type === "tool.approval.resolved") {
      recordApprovalResolved({ id: rest.id, decision: rest.decision, feedback: rest.feedback, args: rest.arguments });
    }
    broadcast(type, rest);
  });

  // Agent-filed issues are fire-and-forget: persist + nudge the inbox to refresh.
  setIssueSink((issue) => {
    recordIssue({
      id: issue.id,
      title: issue.title,
      body: issue.body,
      sessionId: issue.session ?? null,
      agent: sessionLabel(issue.session),
      createdAt: issue.createdAt,
    });
    broadcast("inbox.updated", { id: issue.id, kind: "issue", sessionID: issue.session ?? null });
  });
}

/**
 * Dispatch an inbox/approval HTTP route.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {{ authOk: (req, url) => boolean, readBody: (req) => Promise<string> }} deps
 * @returns {Promise<boolean>} true if the request was handled
 */
export async function handleInboxRoute(req, res, url, { authOk, readBody }) {
  const p = url.pathname;
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); return true; };
  const gate = () => { if (authOk(req, url)) return false; send(401, { error: "unauthorized" }); return true; };
  const readJson = async () => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } };

  // GET /api/approvals — live pending approvals (chat's inline panel uses this).
  if (p === "/api/approvals" && req.method === "GET") {
    if (gate()) return true;
    return send(200, { approvals: listPending() });
  }

  // POST /api/approvals/:id/(accept|reject) — resolve a pending approval.
  // If the live promise is gone (e.g. after a restart) but a pending row
  // remains, still resolve the row so the inbox doesn't get stuck.
  const decide = p.match(/^\/api\/approvals\/([^/]+)\/(accept|reject)$/);
  if (decide && req.method === "POST") {
    if (gate()) return true;
    const [, id, action] = decide;
    const body = await readJson();
    const live = action === "accept"
      ? acceptApproval(id, body.arguments)
      : rejectApproval(id, body.feedback);
    if (!live) {
      recordApprovalResolved({
        id,
        decision: action,
        ...(action === "accept" ? { args: body.arguments } : { feedback: body.feedback }),
      });
    }
    broadcast("inbox.updated", { id, kind: "approval" });
    return send(200, { ok: true, live });
  }

  // GET /api/inbox?filter=attention|completed|all — unified approvals + issues.
  if (p === "/api/inbox" && req.method === "GET") {
    if (gate()) return true;
    return send(200, { items: listItems(url.searchParams.get("filter") || "all") });
  }

  // POST /api/inbox/:id/resolve — mark an issue done.
  const resolve = p.match(/^\/api\/inbox\/([^/]+)\/resolve$/);
  if (resolve && req.method === "POST") {
    if (gate()) return true;
    const id = resolve[1];
    const ok = resolveItem(id, (await readJson()).note);
    broadcast("inbox.updated", { id, kind: "issue" });
    return ok ? send(200, { ok: true }) : send(404, { error: "item not found or already resolved" });
  }

  return false;
}
