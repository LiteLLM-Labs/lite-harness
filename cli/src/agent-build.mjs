// Builds an agent definition from interview answers. Pure + testable; the
// interactive prompting lives in commands/chat.mjs. The returned object mirrors
// the Anthropic Managed Agents body (name/model/system/tools) plus cadence, and
// is sent to the server as `/agent save <json>`.

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TOOLS = [{ type: "agent_toolset_20260401" }];

/** Derive a short name from the task when the user doesn't give one. */
export function autoName(task) {
  const words = String(task || "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return words.length ? words.join(" ") : "agent";
}

/**
 * Assemble the agent definition from interview answers.
 * @param {{ task: string, cadence?: string, name?: string, model?: string }} a
 * @returns {{ name, model, system, tools, cadence }}
 */
export function buildAgentDef({ task, cadence, name, model }) {
  const t = String(task || "").trim();
  if (!t) throw new Error("agent task is required");
  const n = String(name || "").trim() || autoName(t);
  const system = `You are ${n}, an autonomous agent.\n\nYour job: ${t}\n\nOn each run, work proactively toward this and report what you did.`;
  return {
    name: n,
    model: model || DEFAULT_MODEL,
    system,
    tools: DEFAULT_TOOLS,
    cadence: String(cadence || "none").trim(),
  };
}
