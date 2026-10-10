import { createInterface } from 'node:readline';
import { executeWorkspaceTool, workspaceToolDefinitions } from './adapters.mjs';

const [, , cwd, mode] = process.argv;
if (!cwd || !['read', 'write'].includes(mode)) throw new Error('Expected a workspace and read/write mode.');
const tools = workspaceToolDefinitions(mode === 'write');
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (Buffer.byteLength(line) > 1024 * 1024) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    respond(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'swarm-workspace', version: '0.1.0' } });
  } else if (message.method === 'ping') respond(message.id, {});
  else if (message.method === 'tools/list') respond(message.id, { tools });
  else if (message.method === 'tools/call') {
    try {
      if (!tools.some(tool => tool.name === message.params?.name)) throw new Error('This workspace tool is not enabled.');
      const text = await executeWorkspaceTool(cwd, message.params.name, message.params.arguments);
      respond(message.id, { content: [{ type: 'text', text }] });
    } catch (error) { respond(message.id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } }) + '\n');
}
