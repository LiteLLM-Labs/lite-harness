// Platform MCP tool registry — barrel.
//
// Importing this module registers every built-in platform tool with the MCP
// server (each submodule calls registerTool at import time, for its side effect).
// Add a new tool group as its own file under ./tools/ and import it here — keep
// this file a list of imports, never a place to define tools. See ./AGENTS.md.

import "./tools/save-agent.mjs";
import "./tools/agent-files.mjs";
import "./tools/human-approval.mjs";
import "./tools/file-issue.mjs";
import "./tools/memory.mjs";
import "./tools/sandbox.mjs";
