// Platform tool: save_agent — persist the current agent as a named, reusable
// CLI agent (relaunched with `lite <agent_name>`). See ../agents/store.mjs.

import { registerTool } from "../server.mjs";
import { saveAgent } from "../agents/store.mjs";

registerTool(
  {
    name: "save_agent",
    description:
      "Persist this agent as a named, reusable CLI agent. Use this — NOT a memory tool — when the user asks to save, persist, or reuse this agent/persona/assistant. Saved agents are launched by name: `lite <agent_name>` starts a new session with this exact system prompt and behavior. This is the canonical way to save agents in this platform.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description:
            "Short name for the agent, used as `lite <agent_name>` to launch it (e.g. 'security-reviewer', 'mybot')",
        },
        system_prompt: {
          type: "string",
          description:
            "Complete system prompt that fully captures this agent's role, persona, constraints, behaviors, and any key context. Be comprehensive — this is the only thing that will be loaded when the agent is relaunched.",
        },
      },
      required: ["agent_name", "system_prompt"],
    },
  },
  async ({ agent_name, system_prompt }) => {
    const row = saveAgent(agent_name, system_prompt);
    return { agent_id: row.id, name: row.name };
  },
);
