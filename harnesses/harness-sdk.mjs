/**
 * harness-sdk.mjs — unified interface for all agent harnesses.
 *
 * ## Problem
 * inline-adapter.mjs manages four harnesses (cc, opencode, github-copilot,
 * codex) whose session state and message-retrieval paths are fundamentally
 * different:
 *
 *   - cc / copilot / codex: in-process Maps → history array
 *   - opencode: out-of-process child → HTTP GET /session/:id/message
 *
 * Callers that need "the messages for this session" previously hard-coded the
 * opencode HTTP path, silently returning nothing for any other harness.
 *
 * ## Solution
 * HarnessSDK is a thin dispatcher that receives references to all session
 * stores at construction time and exposes a harness-agnostic API.  Callers
 * hold one HarnessSDK instance and call sdk.getMessages(sessionId) without
 * caring which harness is underneath.
 *
 * ## Extending
 * To add a new harness:
 *   1. Add its session Map to the HarnessSDK constructor options.
 *   2. Add a case in getMessages() (and any other methods you add).
 *   3. Register sessions with registerSession(sid, harnessType) whenever a
 *      new session is created (inline-adapter already calls sessionAgent.set
 *      which is the same Map).
 *
 * ## Future methods to add here
 * The four methods that would close the abstraction fully:
 *   - sendPrompt(sessionId, prompt)   — currently callPromptAsync in adapter
 *   - createSession(harnessType, ...)  — currently spread across the run handler
 *   - waitForCompletion(runId, sid, ...) — currently pollOpencodeRunCompletion
 *   - destroySession(sessionId)        — currently ad-hoc per harness
 */

/**
 * @typedef {Object} HarnessSDKOptions
 * @property {Map<string,string>}     sessionHarness    - sessionId → harness type
 *   ('cc' | 'opencode' | 'github-copilot' | 'codex').
 *   In inline-adapter this is the existing `sessionAgent` Map — pass it by
 *   reference; the SDK reads it live so newly registered sessions are visible
 *   immediately without re-initialization.
 * @property {Map<string,{history: Array}>} ccSessions       - claude-code session store
 * @property {Map<string,{history: Array}>} copilotSessions  - github-copilot session store
 * @property {Map<string,{history: Array}>} codexSessions    - codex session store
 * @property {(sessionId: string) => Promise<Array>} getOcMessages
 *   Async function that fetches messages for an opencode session from the
 *   child-process HTTP API.  Injected so harness-sdk.mjs has no import
 *   dependency on inline-adapter and avoids circular modules.
 */

export class HarnessSDK {
  /**
   * @param {HarnessSDKOptions} opts
   */
  constructor({ sessionHarness, ccSessions, copilotSessions, codexSessions, getOcMessages }) {
    this._sessionHarness = sessionHarness;
    this._cc = ccSessions;
    this._copilot = copilotSessions;
    this._codex = codexSessions;
    this._getOcMessages = getOcMessages;
  }

  /**
   * Return the harness type for a session, defaulting to 'opencode'.
   *
   * @param {string} sessionId
   * @returns {'cc'|'opencode'|'github-copilot'|'codex'|string}
   */
  harnessFor(sessionId) {
    return this._sessionHarness.get(sessionId) ?? "opencode";
  }

  /**
   * Retrieve all messages for a session, regardless of harness.
   *
   * For in-process harnesses (cc, github-copilot, codex) this reads the
   * history array held in the corresponding session Map — no I/O.
   * For opencode this delegates to the injected getOcMessages() which issues
   * an HTTP request to the opencode child process.
   *
   * The returned array uses the shared wire format:
   *   { info: { id, role, finish?, ... }, parts: [{ type, text?, ... }] }
   *
   * @param {string} sessionId
   * @returns {Promise<Array>}
   */
  async getMessages(sessionId) {
    const harness = this.harnessFor(sessionId);
    switch (harness) {
      case "cc":
        return this._cc.get(sessionId)?.history ?? [];
      case "github-copilot":
        return this._copilot.get(sessionId)?.history ?? [];
      case "codex":
        return this._codex.get(sessionId)?.history ?? [];
      default:
        return this._getOcMessages(sessionId);
    }
  }

  /**
   * Extract the latest assistant reply text from a message array.
   *
   * Walks the history in reverse, finds the first assistant message that has
   * at least one non-empty text part, and returns the joined text.
   *
   * This is intentionally harness-agnostic: all harnesses write messages in
   * the same wire format so a single implementation covers all of them.
   *
   * @param {Array} messages - array from getMessages()
   * @returns {string}  plain text, or "" if no assistant text found
   */
  latestAssistantText(messages) {
    const history = Array.isArray(messages) ? messages : [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg?.info?.role !== "assistant") continue;
      const text = (msg.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "";
  }
}
