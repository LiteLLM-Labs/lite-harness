// Platform tool: request_human_approval — pause and ask a human to approve a
// sensitive action before taking it. Blocks until a human responds. The
// approval lifecycle (queue, accept/reject, edited args) lives in ../approvals.mjs.

import { registerTool } from "../server.mjs";
import { requestApproval } from "../approvals.mjs";

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
  },
);
