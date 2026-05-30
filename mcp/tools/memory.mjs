// Platform tools: agent memory — durable key→value notes scoped to one agent,
// persisted across sessions and scheduled runs. The store lives in
// ../../harnesses/memory-store.mjs (shared SQLite DB). The same data is exposed
// to the UI via GET/POST/DELETE /api/agents/:id/memory.
//
// The memory_* tools are shared across all agents, so every call must be scoped
// by agent_id. Each agent is handed its own id in its system prompt (see
// memoryPromptNote in inline-adapter.mjs) and passes it back here.

import { registerTool } from "../server.mjs";
import {
  storeMemory,
  getMemory,
  listMemory,
  deleteMemory,
} from "../../harnesses/memory-store.mjs";

const AGENT_ID_PROP = {
  type: "string",
  description:
    "Your own agent_id (provided in your system prompt). Scopes the memory to you.",
};

registerTool(
  {
    name: "memory_store",
    description:
      "Save a durable note to your memory under a key, so you can recall it in a later turn, session, or scheduled run. Storing under an existing key overwrites it. Use for facts, user preferences, decisions, and state worth remembering — NOT for saving the agent itself (use save_agent for that).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        key: { type: "string", description: "Short, stable identifier for this note (e.g. 'user_timezone', 'icp')." },
        value: { type: "string", description: "The content to remember. Can be multi-line." },
      },
      required: ["agent_id", "key", "value"],
    },
  },
  async ({ agent_id, key, value }) => {
    if (!agent_id) throw new Error("agent_id is required");
    const row = storeMemory({ agentId: agent_id, key, value: String(value ?? "") });
    return { ok: true, key: row.key, updated_at: row.updated_at };
  },
);

registerTool(
  {
    name: "memory_get",
    description: "Read back a single note you previously saved to memory, by key.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        key: { type: "string", description: "The key the note was stored under." },
      },
      required: ["agent_id", "key"],
    },
  },
  async ({ agent_id, key }) => {
    if (!agent_id) throw new Error("agent_id is required");
    const row = getMemory(agent_id, key);
    return row
      ? { found: true, key: row.key, value: row.value, updated_at: row.updated_at }
      : { found: false };
  },
);

registerTool(
  {
    name: "memory_list",
    description:
      "List every note currently in your memory (keys, values, and when each was last updated). Call this at the start of a task to recall what you already know.",
    inputSchema: {
      type: "object",
      properties: { agent_id: AGENT_ID_PROP },
      required: ["agent_id"],
    },
  },
  async ({ agent_id }) => {
    if (!agent_id) throw new Error("agent_id is required");
    const rows = listMemory(agent_id);
    return {
      count: rows.length,
      memories: rows.map((r) => ({ key: r.key, value: r.value, updated_at: r.updated_at })),
    };
  },
);

registerTool(
  {
    name: "memory_delete",
    description: "Forget a note by deleting it from your memory.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        key: { type: "string", description: "The key of the note to delete." },
      },
      required: ["agent_id", "key"],
    },
  },
  async ({ agent_id, key }) => {
    if (!agent_id) throw new Error("agent_id is required");
    const deleted = deleteMemory(agent_id, key);
    return { ok: true, deleted };
  },
);
