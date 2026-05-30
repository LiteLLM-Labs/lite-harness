/**
 * agent-run-store.mjs
 *
 * In-memory event buffer for agent run SSE log streaming.
 * Each run gets a buffer of raw SSE data lines so clients that connect
 * after the run completes can still read the full log.
 *
 * SQLite persistence (createAgentRun, getAgentRun, etc.) lives in loop-store.mjs.
 */

// runId → { events: string[], listeners: Set<(line: string) => void> }
const _runBuffers = new Map();

export function initRunBuffer(runId) {
  if (!_runBuffers.has(runId)) {
    _runBuffers.set(runId, { events: [], listeners: new Set() });
  }
}

/** Store an SSE data line and fan it out to any live subscribers. */
export function bufferRunEvent(runId, sseDataLine) {
  const buf = _runBuffers.get(runId);
  if (!buf) return;
  buf.events.push(sseDataLine);
  for (const listener of buf.listeners) {
    try { listener(sseDataLine); } catch {}
  }
}

/** Subscribe to live events for a run (for streaming clients). */
export function subscribeRunEvents(runId, listener) {
  initRunBuffer(runId);
  _runBuffers.get(runId).listeners.add(listener);
}

/** Unsubscribe a live listener. */
export function unsubscribeRunEvents(runId, listener) {
  _runBuffers.get(runId)?.listeners.delete(listener);
}

/** Return buffered SSE lines for a completed run, or null if no buffer exists. */
export function getRunEventBuffer(runId) {
  return _runBuffers.get(runId)?.events ?? null;
}

/** Free memory for a run (call after the run is archived). */
export function clearRunBuffer(runId) {
  _runBuffers.delete(runId);
}
