// Platform tools: agent files — persist files an agent creates in its sandbox
// back to the platform so they survive teardown and are re-uploaded on the next
// run. Scoped by agent_id (injected into the agent's run context). The store
// lives in ../../harnesses/agent-file-store.mjs.

import { registerTool } from "../server.mjs";
import {
  upsertAgentFile,
  listAgentFiles,
  deleteAgentFile,
} from "../../harnesses/agent-file-store.mjs";

registerTool(
  {
    name: "persist_file",
    description:
      "Persist a file you created or modified in your sandbox back to the platform so it survives " +
      "sandbox teardown and is automatically re-uploaded on your next run. " +
      "Call this after writing or editing any file you want to keep. " +
      "Your agent_id is injected into your context at run start — use it here.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Your agent ID (provided in your run context as 'agent_id: ...')",
        },
        path: {
          type: "string",
          description: "Relative path of the file, e.g. 'outreach.py' or 'utils/helpers.py'. Must be a .py file.",
        },
        content: {
          type: "string",
          description: "Full text content of the file.",
        },
      },
      required: ["agent_id", "path", "content"],
    },
  },
  async ({ agent_id, path, content }) => {
    const file = upsertAgentFile(agent_id, path, content);
    return { ok: true, path: file.path, size_bytes: file.size_bytes };
  },
);

registerTool(
  {
    name: "list_agent_files",
    description: "List the files currently persisted for your agent. Shows path and size — not content.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "Your agent ID (provided in your run context).",
        },
      },
      required: ["agent_id"],
    },
  },
  async ({ agent_id }) => {
    const files = listAgentFiles(agent_id);
    return { files };
  },
);

registerTool(
  {
    name: "delete_agent_file",
    description: "Remove a persisted file from your agent. It will no longer be uploaded on future runs.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        path: { type: "string", description: "Relative path of the file to delete." },
      },
      required: ["agent_id", "path"],
    },
  },
  async ({ agent_id, path }) => {
    deleteAgentFile(agent_id, path);
    return { ok: true };
  },
);
