import { registerTool } from "./server.mjs";
import { saveAgent } from "./agents/store.mjs";
import { requestApproval } from "./approvals.mjs";
import { fileIssue } from "./issues.mjs";
import { registerSandboxTools } from "./sandbox.mjs";
import { upsertAgentFile, listAgentFiles, deleteAgentFile } from "../harnesses/agent-file-store.mjs";

registerTool(
  {
    name: "save_agent",
    description: "Persist this agent as a named, reusable CLI agent. Use this — NOT a memory tool — when the user asks to save, persist, or reuse this agent/persona/assistant. Saved agents are launched by name: `lite <agent_name>` starts a new session with this exact system prompt and behavior. This is the canonical way to save agents in this platform.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Short name for the agent, used as `lite <agent_name>` to launch it (e.g. 'security-reviewer', 'mybot')"
        },
        system_prompt: {
          type: "string",
          description: "Complete system prompt that fully captures this agent's role, persona, constraints, behaviors, and any key context. Be comprehensive — this is the only thing that will be loaded when the agent is relaunched."
        }
      },
      required: ["agent_name", "system_prompt"]
    }
  },
  async ({ agent_name, system_prompt }) => {
    const row = saveAgent(agent_name, system_prompt);
    return { agent_id: row.id, name: row.name };
  }
);

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

registerTool(
  {
    name: "request_human_approval",
    description:
      "Pause and ask a human to approve a sensitive action before you take it. Call this when your instructions tell you to keep a human in the loop — e.g. before writing to an external system, sending a message, deleting data, or spending money. Blocks until a human responds. Returns { approved, arguments, feedback }: when approved, `arguments` is the (possibly human-edited) action input you should use — perform the action exactly as edited; when not approved, do NOT perform the action and address the human's `feedback` instead.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Name of the action you want approval for (e.g. 'pylon_update_issue', 'send_email', 'delete_branch'). Shown to the human as the title.",
        },
        arguments: {
          type: "object",
          description:
            "The concrete inputs for the action, as a flat object of named fields. Each field is shown to the human as an editable value; the human may change them before approving.",
        },
      },
      required: ["action"],
    },
  },
  async ({ action, arguments: actionArgs }, ctx) => {
    const outcome = await requestApproval(action, actionArgs || {}, { session: ctx?.session });
    if (outcome.decision === "accept") {
      return { approved: true, arguments: outcome.args || {} };
    }
    return { approved: false, feedback: outcome.feedback || "" };
  }
);

registerTool(
  {
    name: "file_issue",
    description:
      "File an informational issue into the human inbox — something a human should see or act on later (a blocker, a question, a result worth surfacing). Unlike request_human_approval this does NOT block: it returns immediately and the human reviews it on their own time. Use request_human_approval instead when you must pause for a yes/no before acting.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short one-line summary shown in the inbox list (e.g. 'Pylon API key missing', 'Deploy blocked on failing test').",
        },
        body: {
          type: "string",
          description: "Full details for the human — what happened, what you need, any context or links. Markdown is rendered.",
        },
      },
      required: ["title"],
    },
  },
  async ({ title, body }, ctx) => {
    const id = fileIssue({ title, body, session: ctx?.session });
    return { issue_id: id, filed: true };
  }
);

// Sandbox tools (provision, execute, read_file, upload_artifact) — available
// to ALL harnesses via PLATFORM_MCP_URL. No-op when no sandbox provider is configured.
registerSandboxTools(registerTool);
