import { registerTool } from "./server.mjs";
import { saveAgent } from "./agents/store.mjs";

registerTool(
  {
    name: "save_agent",
    description: "Save this session as a reusable named agent that can be launched from the CLI with `lite <agent_name>`",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name for the agent — used as `lite <agent_name>` to start a session"
        },
        system_prompt: {
          type: "string",
          description: "Complete system prompt distilled from this session: role, behaviors, constraints, and key context"
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
