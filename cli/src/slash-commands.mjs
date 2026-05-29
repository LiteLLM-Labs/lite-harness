// Slash commands surfaced by the in-session autocomplete menu.
//
// The server's plugin registry is the source of truth for *behavior* (see
// harnesses/*-plugin.mjs); this list only drives discovery + autofill in the
// CLI input box. `args` is a short usage hint shown after the command name.

export const SLASH_COMMANDS = [
  { name: "/loop", args: "<interval> <prompt>", hint: "run a prompt on a repeating interval" },
  { name: "/vault", args: "KEY=VALUE", hint: "store a secret injected into sandboxes" },
  { name: "/clear", args: "", hint: "reset session history" },
  { name: "/help", args: "", hint: "list available commands" },
];

// Commands matching the partial command token being typed (e.g. "/lo" → /loop).
// Returns [] once the query already equals the only match, so a complete
// command sends on Enter instead of re-opening the menu.
export function matchSlash(query) {
  if (!query.startsWith("/") || /\s/.test(query)) return [];
  const hits = SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  if (hits.length === 1 && hits[0].name === query) return [];
  return hits;
}
