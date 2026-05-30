/**
 * plugin-registry.mjs
 *
 * Plugin infrastructure for lite-harness's inline adapter.
 * Enables slash-command intercepts and lifecycle hooks.
 *
 * ESM module — no external deps, only node:crypto.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// AdapterPlugin — base class that plugins extend
// ---------------------------------------------------------------------------

export class AdapterPlugin {
  /** Human-readable name for this plugin. Override in subclasses. */
  get name() {
    return "unnamed";
  }

  /**
   * Called once when the registry is set up.
   * @param {{ masterKey: string }} ctx
   */
  async setup(ctx) {}

  /**
   * Return true if this plugin wants to handle the given user text.
   * @param {string} text
   * @param {{ sessionId: string, harness: string, model: string }} ctx
   * @returns {boolean}
   */
  matches(text, ctx) {
    return false;
  }

  /**
   * Handle the text. Use the emitter to stream output back to the client.
   * @param {string} text
   * @param {{ sessionId: string, harness: string, model: string }} ctx
   * @param {{ text: (str: string) => void, done: () => void, error: (msg: string) => void }} emitter
   */
  async handle(text, ctx, emitter) {}

  /**
   * Called whenever a new session is created.
   * @param {{ id: string, harness: string, title: string }} session
   * @param {object} ctx
   */
  async onSessionCreate(session, ctx) {}

  /**
   * Called on every incoming prompt_async body before it is forwarded.
   * @param {object} body  Parsed request body.
   * @param {object} ctx
   */
  async onPromptAsync(body, ctx) {}

  /**
   * Called whenever a session transitions to the idle state.
   * @param {string} sessionId
   * @param {object} ctx
   */
  async onSessionIdle(sessionId, ctx) {}
}

// ---------------------------------------------------------------------------
// PluginRegistry — holds all registered plugins and dispatches events
// ---------------------------------------------------------------------------

export class PluginRegistry {
  constructor() {
    /** @type {AdapterPlugin[]} */
    this._plugins = [];
  }

  /**
   * Add a plugin to the registry.
   * @param {AdapterPlugin} plugin
   */
  register(plugin) {
    this._plugins.push(plugin);
  }

  getPlugin(name) {
    return this._plugins.find(p => p.name === name) ?? null;
  }

  /**
   * Run setup() on every registered plugin.
   * @param {{ masterKey: string }} ctx
   */
  async setup(ctx) {
    for (const plugin of this._plugins) {
      try {
        await plugin.setup(ctx);
      } catch (err) {
        console.error(`[plugin-registry] setup error in plugin "${plugin.name}":`, err);
      }
    }
  }

  /**
   * Find the first plugin whose matches() returns true and call its handle().
   * @param {string} text
   * @param {{ sessionId: string, harness: string, model: string }} ctx
   * @param {{ text: (str: string) => void, done: () => void, error: (msg: string) => void }} emitter
   * @returns {Promise<boolean>} true if a plugin handled the text, false otherwise
   */
  async matchAndHandle(text, ctx, emitter) {
    for (const plugin of this._plugins) {
      let matched = false;
      try {
        matched = plugin.matches(text, ctx);
      } catch (err) {
        console.error(`[plugin-registry] matches() error in plugin "${plugin.name}":`, err);
        continue;
      }

      if (matched) {
        try {
          await plugin.handle(text, ctx, emitter);
        } catch (err) {
          console.error(`[plugin-registry] handle() error in plugin "${plugin.name}":`, err);
          try {
            emitter.error(err instanceof Error ? err.message : String(err));
          } catch {}
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Fire onSessionCreate on all plugins (fire-and-forget, isolated failures).
   * @param {{ id: string, harness: string, title: string }} session
   * @param {object} ctx
   */
  async onSessionCreate(session, ctx) {
    for (const plugin of this._plugins) {
      try {
        await plugin.onSessionCreate(session, ctx);
      } catch (err) {
        console.error(`[plugin-registry] onSessionCreate error in plugin "${plugin.name}":`, err);
      }
    }
  }

  /**
   * Fire onPromptAsync on all plugins (fire-and-forget, isolated failures).
   * @param {object} body
   * @param {object} ctx
   */
  async onPromptAsync(body, ctx) {
    for (const plugin of this._plugins) {
      try {
        await plugin.onPromptAsync(body, ctx);
      } catch (err) {
        console.error(`[plugin-registry] onPromptAsync error in plugin "${plugin.name}":`, err);
      }
    }
  }

  /**
   * Fire onSessionIdle on all plugins (fire-and-forget, isolated failures).
   * @param {string} sessionId
   * @param {object} ctx
   */
  async onSessionIdle(sessionId, ctx) {
    for (const plugin of this._plugins) {
      try {
        await plugin.onSessionIdle(sessionId, ctx);
      } catch (err) {
        console.error(`[plugin-registry] onSessionIdle error in plugin "${plugin.name}":`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// createEmitter — wraps a raw SSE write function into a typed emitter
// ---------------------------------------------------------------------------

/**
 * Build an emitter that serialises plugin output into the inline-adapter's
 * SSE event format and writes it via `writeLine`.
 *
 * Event envelope:
 *   { id: "evt_<uuid>", type: "<type>", properties: { sessionID: "<sid>", ...rest } }
 * Written as:   data: <json>\n\n
 *
 * @param {string} sessionId  — used as `properties.sessionID` in every event
 * @param {(line: string) => void} writeLine  — writes a raw SSE data line
 * @returns {{ text: (str: string) => void, done: () => void, error: (msg: string) => void }}
 */
export function createEmitter(sessionId, writeLine) {
  // A single msgId is shared across all text() calls so that streaming chunks
  // appear as parts of the same assistant message.
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const partId = `${msgId}_b0`;

  function emit(type, props) {
    const ev = {
      id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type,
      properties: { ...props, sessionID: sessionId },
    };
    try {
      writeLine(`data: ${JSON.stringify(ev)}\n\n`);
    } catch (err) {
      console.error("[plugin-registry] createEmitter writeLine error:", err);
    }
  }

  return {
    /**
     * Stream a text chunk as two events:
     *   1. message.updated  — announces/refreshes the assistant message metadata
     *   2. message.part.updated — carries the text content
     * @param {string} str
     */
    text(str) {
      emit("message.updated", {
        info: {
          id: msgId,
          role: "assistant",
          time: { created: Date.now() },
        },
      });
      emit("message.part.updated", {
        part: {
          id: partId,
          messageID: msgId,
          type: "text",
          text: str,
        },
      });
    },

    /**
     * Signal that the session is now idle (turn complete).
     */
    done() {
      emit("session.idle", {});
    },

    /**
     * Signal a session-level error.
     * @param {string} msg
     */
    error(msg) {
      emit("session.error", {
        error: { message: msg },
      });
    },
  };
}
