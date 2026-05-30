// Agent-filed issues.
//
// The `file_issue` tool lets an agent drop an informational note into the human
// inbox — "here's something you should see" — without blocking (unlike
// request_human_approval). This module just mints an id and forwards the issue
// to a sink the harness registers; the harness owns persistence + SSE so this
// module stays dependency-free and unit-testable, mirroring approvals.mjs.
//
// ESM module — no external deps, only node:crypto.

import { randomUUID } from "node:crypto";

/** @type {((issue: object) => void) | null} */
let sink = null;

/**
 * Register the function that persists + broadcasts a filed issue.
 * @param {(issue: { id: string, title: string, body: string, session: string|null, createdAt: number }) => void} fn
 */
export function setIssueSink(fn) {
  sink = fn;
}

/**
 * File an issue into the inbox. Returns the new issue id immediately.
 * @param {{ title?: string, body?: string, session?: string|null }} input
 * @returns {string}
 */
export function fileIssue({ title, body, session } = {}) {
  const id = `iss_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const issue = {
    id,
    title: (title || "").trim() || "Untitled issue",
    body: body || "",
    session: session || null,
    createdAt: Date.now(),
  };
  if (sink) {
    try {
      sink(issue);
    } catch (err) {
      console.error("[issues] sink error:", err);
    }
  }
  return id;
}

/** Test helper — drop the registered sink. */
export function _reset() {
  sink = null;
}
