// Platform tool: file_issue — file an informational item into the human inbox.
// Non-blocking (unlike request_human_approval): returns immediately and the
// human reviews it later. The inbox record is written by ../issues.mjs.

import { registerTool } from "../server.mjs";
import { fileIssue } from "../issues.mjs";

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
  },
);
