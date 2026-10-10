import { Type } from '@earendil-works/pi-ai';
import { executeWorkspaceTool, workspaceToolDefinitions } from './adapters.mjs';
import { superviseWorkspaceCommands } from './workspace-command.mjs';

// Pi loads this explicit extension with built-in tools, discovery and MCP disabled.
export default function workspaceExtension(pi) {
  const cwd = process.env.SWARM_WORKSPACE_ROOT;
  if (!cwd) throw new Error('Swarm workspace was not configured.');
  const actionsEnabled = process.env.SWARM_WORKSPACE_WRITE === '1';
  superviseWorkspaceCommands();
  for (const tool of workspaceToolDefinitions(actionsEnabled)) {
    const fields = tool.name === 'run_command'
      ? {command: Type.String(), timeoutMs: Type.Optional(Type.Integer({minimum: 1, maximum: 120000}))}
      : { path: Type.String({ description: 'Relative workspace path.' }) };
    if (tool.name === 'write_file') fields.content = Type.String();
    pi.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: Type.Object(fields),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const text = await executeWorkspaceTool(cwd, tool.name, params, {signal, actionsEnabled});
        const result = tool.name === 'run_command' ? JSON.parse(text) : null;
        return { content: [{ type: 'text', text }], details: { path: params.path, command: params.command, ...(result || {}) }, ...(result && result.exitCode !== 0 ? {isError: true} : {}) };
      },
    });
  }
}
