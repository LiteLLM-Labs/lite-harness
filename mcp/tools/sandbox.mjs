// Platform tools: sandbox — provision / execute / read_file / upload_artifact,
// available to ALL harnesses via PLATFORM_MCP_URL. The registrations live in
// ../sandbox.mjs (registerSandboxTools); they no-op when no sandbox provider is
// configured. This module just wires them into the registry.

import { registerTool } from "../server.mjs";
import { registerSandboxTools } from "../sandbox.mjs";

registerSandboxTools(registerTool);
