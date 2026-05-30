// Catalog of available integrations. Each entry is a well-known MCP server that
// the harness can connect to once the user supplies an API key. Rendered by the
// /integrations page — add a new object here to surface a new integration.

export interface Integration {
  id: string;
  name: string;
  /** Short one-liner shown under the name on the card. */
  description: string;
  /** Group header the card is rendered under (e.g. "Google", "Other"). */
  category: string;
  /** Vault key the API key is stored under (and the label shown in the modal). */
  envKey: string;
  /** Well-known MCP server endpoint this integration connects to. */
  mcpUrl: string;
  /** Tools this MCP server exposes once connected. */
  tools: string[];
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, compose, and organize emails in your Gmail inbox.",
    category: "Google",
    envKey: "GMAIL_API_KEY",
    mcpUrl: "https://mcp.composio.dev/gmail",
    tools: ["Gmail Search", "Gmail Send", "Gmail Read Thread", "Gmail Create Draft"],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Track issues, plan sprints, and coordinate team projects in Linear.",
    category: "Other",
    envKey: "LINEAR_API_KEY",
    mcpUrl: "https://mcp.linear.app/sse",
    tools: ["Linear List Issues", "Linear Get Issue", "Linear Create Issue", "Linear Update Issue"],
  },
  {
    id: "pylon",
    name: "Pylon",
    description: "View and respond to customer support conversations across channels.",
    category: "Other",
    envKey: "PYLON_API_KEY",
    mcpUrl: "https://mcp.usepylon.com",
    tools: ["Pylon List Issues", "Pylon Get Issue", "Pylon Update Issue"],
  },
];

/** Order categories appear in on the page. Unlisted categories fall to the end. */
export const CATEGORY_ORDER = ["Google", "Microsoft", "Other"];

export function integrationsByCategory(): [string, Integration[]][] {
  const groups = new Map<string, Integration[]>();
  for (const it of INTEGRATIONS) {
    const arr = groups.get(it.category) ?? [];
    arr.push(it);
    groups.set(it.category, arr);
  }
  return [...groups.entries()].sort(
    (a, b) => orderIndex(a[0]) - orderIndex(b[0]),
  );
}

function orderIndex(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}
