// Platform MCP server — tool registry + JSON-RPC handler
// Supports both MCP transports:
//   Streamable HTTP: POST /mcp
//   HTTP+SSE (legacy): GET /mcp/sse  +  POST /mcp/message

import { randomUUID } from "node:crypto";

const toolRegistry = new Map(); // name → { definition, handler }

// SSE sessions: sessionId → { res (SSE response writer) }
const sseSessions = new Map();

export function registerTool(definition, handler) {
  toolRegistry.set(definition.name, { definition, handler });
}

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcpRequest(body, ctx = {}) {
  const { method, id, params } = body;

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lite-harness-platform", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null;

    case "tools/list":
      return jsonRpc(id, {
        tools: [...toolRegistry.values()].map((e) => e.definition),
      });

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const entry = toolRegistry.get(name);
      if (!entry) return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
      try {
        const result = await entry.handler(args, ctx);
        return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        return jsonRpc(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }

    default:
      return jsonRpcError(id, -32601, "Method not found");
  }
}

// HTTP+SSE transport — GET /mcp/sse
// Opens SSE stream and sends the message endpoint URL to the client.
export function handleMcpSse(req, res, messageUrl) {
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 16);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  sseSessions.set(sessionId, res);
  res.on("close", () => sseSessions.delete(sessionId));

  // Send endpoint event — tells client where to POST messages
  res.write(`event: endpoint\ndata: ${messageUrl}?sessionId=${sessionId}\n\n`);
}

// HTTP+SSE transport — POST /mcp/message?sessionId=xxx
// Receives JSON-RPC, executes, sends response back via SSE stream.
export async function handleMcpMessage(body, sessionId) {
  const response = await handleMcpRequest(body);
  if (response === null) return; // notification, no response needed
  const sseRes = sseSessions.get(sessionId);
  if (sseRes) {
    sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  }
}
