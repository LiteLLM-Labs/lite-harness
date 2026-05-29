export { handleMcpRequest, registerTool } from "./server.mjs";

const PORT = Number(process.env.PORT || 4096);
export const PLATFORM_MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
