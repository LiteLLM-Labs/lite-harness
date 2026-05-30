import { registerTool } from "./server.mjs";
import { saveAgent } from "./agents/store.mjs";
import { requestApproval } from "./approvals.mjs";
import { fileIssue } from "./issues.mjs";

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
