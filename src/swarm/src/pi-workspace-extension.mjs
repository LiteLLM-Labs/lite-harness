import { Type } from '@earendil-works/pi-ai';
import { executeWorkspaceTool, workspaceToolDefinitions } from './adapters.mjs';

// Pi loads this explicit extension with built-in tools, discovery and MCP disabled.
export default function workspaceExtension(pi) {
  const cwd = process.env.SWARM_WORKSPACE_ROOT;
  if (!cwd) throw new Error('Swarm workspace was not configured.');
  for (const tool of workspaceToolDefinitions(process.env.SWARM_WORKSPACE_WRITE === '1')) {
    const fields = { path: Type.String({ description: 'Relative workspace path.' }) };
    if (tool.name === 'write_file') fields.content = Type.String();
    pi.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: Type.Object(fields),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const text = await executeWorkspaceTool(cwd, tool.name, params);
        return { content: [{ type: 'text', text }], details: { path: params.path } };
      },
    });
  }
}
