import { createInterface } from 'node:readline';
import { executeWorkspaceTool, workspaceToolDefinitions } from './adapters.mjs';
import { stopWorkspaceCommands, superviseWorkspaceCommands } from './workspace-command.mjs';

const [, , cwd, mode] = process.argv;
if (!cwd || !['read', 'write', 'command'].includes(mode)) throw new Error('Expected a workspace and read/write/command mode.');
const tools = workspaceToolDefinitions(mode !== 'read').filter(tool => mode !== 'command' || tool.name === 'run_command');
const pending = new Map();
let closed = false;
const respond = (id, result) => { if (!closed) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); };
process.stdout.on('error', () => {});
superviseWorkspaceCommands();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function execute(message, controller) {
  try {
    if (!tools.some(tool => tool.name === message.params?.name)) throw new Error('This workspace tool is not enabled.');
    const text = await executeWorkspaceTool(cwd, message.params.name, message.params.arguments, {signal: controller.signal, actionsEnabled: mode !== 'read'});
    const result = message.params.name === 'run_command' ? JSON.parse(text) : null;
    respond(message.id, {content: [{type: 'text', text}], ...(result && (result.exitCode !== 0 || result.timedOut || result.truncated) ? {isError: true} : {})});
  } catch (error) { respond(message.id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
}
for await (const line of lines) {
  if (Buffer.byteLength(line) > 1024 * 1024) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
  if (message.method === 'notifications/cancelled') {
    pending.get(message.params?.requestId)?.controller.abort(new Error('Tool call cancelled.'));
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    respond(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'swarm-workspace', version: '0.1.0' } });
  } else if (message.method === 'ping') respond(message.id, {});
  else if (message.method === 'tools/list') respond(message.id, { tools });
  else if (message.method === 'tools/call') {
    if (pending.has(message.id)) {respond(message.id, {isError: true, content: [{type: 'text', text: 'Duplicate active request ID.'}]}); continue;}
    const controller = new AbortController();
    const promise = execute(message, controller).finally(() => pending.delete(message.id));
    pending.set(message.id, {controller, promise});
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } }) + '\n');
}
closed = true;
for (const {controller} of pending.values()) controller.abort(new Error('Workspace tool connection closed.'));
await stopWorkspaceCommands(new Error('Workspace tool connection closed.'));
await Promise.allSettled([...pending.values()].map(({promise}) => promise));
