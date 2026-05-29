// Platform MCP server — tool registry + JSON-RPC handler
// MCP Streamable HTTP transport uses JSON-RPC 2.0

const toolRegistry = new Map(); // name → { definition, handler }

export function registerTool(definition, handler) {
  toolRegistry.set(definition.name, { definition, handler });
}

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcpRequest(body) {
  const { method, id, params } = body;

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lite-harness-platform", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null; // notifications need no response

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
        const result = await entry.handler(args);
        return jsonRpc(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (e) {
        return jsonRpc(id, {
          content: [{ type: "text", text: e.message }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, "Method not found");
  }
}
