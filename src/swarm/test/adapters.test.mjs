import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableHarnesses, buildCliCommand, executeWorkspaceTool, gatewayUrl, parseSse, runAgent, workspaceToolDefinitions } from '../src/adapters.mjs';
import { prepareHarnessProfile } from '../src/harness-profiles.mjs';

async function workspace(t) {
  const folder = await mkdtemp(join(tmpdir(), 'swarm-adapter-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

function streamResponse(events) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function fakeCli(t, folder, source) {
  const file = join(folder, 'fake-cli.mjs');
  await writeFile(file, `#!${process.execPath}\n${source}`);
  await chmod(file, 0o700);
  return file;
}

test('gateway normalizes /v1 and disallows insecure nonlocal or credential-bearing URLs', () => {
  assert.equal(gatewayUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(gatewayUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/v1/chat/completions');
  assert.throws(() => gatewayUrl('http://example.com'));
  assert.throws(() => gatewayUrl('https://user:secret@example.com'));
});

test('SSE parser preserves split Unicode, CRLF and ignores comments', async () => {
  const bytes = Buffer.from(': ping\r\n\r\ndata: {"text":"🌌"}\r\n\r\ndata: [DONE]\r\n\r\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events = [];
  for await (const event of parseSse(chunks())) events.push(event);
  assert.deepEqual(events, [{ text: '🌌' }]);
});

test('workspace tools read/write and reject parent traversal, leaf and parent symlink escapes', async t => {
  const folder = await workspace(t);
  const root = join(folder, 'root');
  await mkdir(root);
  await writeFile(join(folder, 'outside.txt'), 'outside');
  await symlink(join(folder, 'outside.txt'), join(root, 'leaf'));
  await symlink(folder, join(root, 'parent'));
  for (const path of ['../outside.txt', '/etc/passwd', 'leaf', 'parent/outside.txt', 'parent/new.txt', '.git/config']) {
    await assert.rejects(executeWorkspaceTool(root, 'read_file', { path }));
    await assert.rejects(executeWorkspaceTool(root, 'write_file', { path, content: 'bad' }));
  }
  await executeWorkspaceTool(root, 'write_file', { path: 'result/report.md', content: '# Done\n' });
  assert.equal(await executeWorkspaceTool(root, 'read_file', { path: 'result/report.md' }), '# Done\n');
  assert.equal(await readFile(join(folder, 'outside.txt'), 'utf8'), 'outside');
  await assert.rejects(executeWorkspaceTool(root, 'write_file', { path: 'huge', content: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
  await assert.rejects(executeWorkspaceTool(root, 'write_file', { path: '.', content: 'bad' }), /workspace directory/);
  await assert.rejects(executeWorkspaceTool(root, 'shell', { path: '.' }), /Unknown workspace tool/);
});

test('native consumes split tool arguments, executes real workspace writes, and returns usage', async t => {
  const cwd = await workspace(t);
  const events = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(options.redirect, 'error');
    if (calls++ === 0) {
      assert.equal(request.tools.length, 4);
      return streamResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":"result.txt",' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"Done"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]);
    }
    assert.equal(request.messages.at(-1).role, 'tool');
    assert.equal(JSON.parse(request.messages.at(-1).content).saved, 'result.txt');
    return streamResponse([
      { choices: [{ index: 0, delta: { content: 'Saved.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
    ]);
  });
  const result = await runAgent({ prompt: 'Save the result', cwd, toolsEnabled: true, env: { LITELLM_API_KEY: 'test-secret-key', LITELLM_MODEL: 'test-model' }, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Saved.');
  assert.equal(result.model, 'test-model');
  assert.equal(result.usage.total_tokens, 38);
  assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'Done');
  assert(events.some(event => event.type === 'tool' && event.status === 'completed'));
});

test('native defaults to read-only tools and rejects an unadvertised write', async t => {
  const cwd = await workspace(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['list_files', 'read_file']);
    if (calls++ === 0) return streamResponse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":"unexpected.txt","content":"bad"}' } }] }, finish_reason: 'tool_calls' }] }]);
    assert.match(request.messages.at(-1).content, /Local actions are disabled/);
    return streamResponse([{ choices: [{ index: 0, delta: { content: 'Writes disabled.' }, finish_reason: 'stop' }] }]);
  });
  await runAgent({ prompt: 'Read only', cwd, env: { LITELLM_API_KEY: 'test-secret-key' } });
  await assert.rejects(readFile(join(cwd, 'unexpected.txt')), { code: 'ENOENT' });
});

test('local actions advertise bounded commands only when enabled and keep Claude native Bash unavailable', async t => {
  const cwd = await workspace(t);
  assert.deepEqual(workspaceToolDefinitions(false).map(tool => tool.name), ['list_files', 'read_file']);
  assert(workspaceToolDefinitions(true).some(tool => tool.name === 'run_command'));
  await assert.rejects(executeWorkspaceTool(cwd, 'run_command', {command: 'echo blocked'}), /Local actions are disabled/);
  const enabled = buildCliCommand({harness: 'claude', cwd, toolsEnabled: true});
  assert(!enabled.args.includes('--safe-mode'));
  assert.equal(enabled.args[enabled.args.indexOf('--setting-sources') + 1], '');
  const config = JSON.parse(enabled.args[enabled.args.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers.swarm_actions.args.at(-1), 'command');
  assert.equal(config.mcpServers.swarm_actions.alwaysLoad, true);
  assert(enabled.args[enabled.args.indexOf('--allowedTools') + 1].includes('mcp__swarm_actions__run_command'));
  assert(!enabled.args[enabled.args.indexOf('--tools') + 1].includes('Bash'));
  const pi = buildCliCommand({harness: 'pi', cwd, toolsEnabled: true});
  assert(pi.args[pi.args.indexOf('--tools') + 1].includes('run_command'));
});

test('native performs an actual sandboxed command and reports redacted public command results', {skip: process.platform !== 'darwin'}, async t => {
  const cwd = await workspace(t);
  const events = [];
  const secret = 'synthetic-command-test-secret';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    if (calls++ === 0) return streamResponse([{choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'command-1', function: {name: 'run_command', arguments: JSON.stringify({command: `printf actual > verified.txt; printf ${secret}`})}}]}, finish_reason: 'tool_calls'}]}]);
    const result = JSON.parse(request.messages.at(-1).content);
    assert.equal(result.stdout, '[redacted]');
    assert.equal(result.exitCode, 0);
    return streamResponse([{choices: [{index: 0, delta: {content: 'Created and verified.'}, finish_reason: 'stop'}]}]);
  });
  await runAgent({cwd, prompt: 'Create and verify a file', toolsEnabled: true, env: {LITELLM_API_KEY: secret}, onEvent: event => events.push(event)});
  assert.equal(await readFile(join(cwd, 'verified.txt'), 'utf8'), 'actual');
  const completed = events.find(event => event.name === 'run_command' && event.status === 'completed');
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.stdout, '[redacted]');
  assert(!JSON.stringify(events).includes(secret));
});

test('gateway authentication and incomplete streams fail transparently with no fallback', async t => {
  const cwd = await workspace(t);
  await assert.rejects(runAgent({ prompt: 'hello', cwd, env: {} }), /LITELLM_API_KEY/);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('not authorized', { status: 401 }));
  await assert.rejects(runAgent({ prompt: 'hello', cwd, env: { LITELLM_API_KEY: 'test-secret-key' } }), /HTTP 401/);
  fetch.mock.mockImplementation(async () => streamResponse([{ choices: [{ delta: { content: 'incomplete' } }] }]));
  await assert.rejects(runAgent({ prompt: 'hello', cwd, env: { LITELLM_API_KEY: 'test-secret-key' } }), /stream interrupted/);
});

test('CLI arguments keep native permissions and exclude bypass flags', () => {
  const codex = buildCliCommand({ harness: 'codex', cwd: '/tmp/project', toolsEnabled: true, model: 'test-model' });
  assert(codex.args.includes('workspace-write'));
  assert(codex.args.includes('--ignore-user-config'));
  for (const feature of ['plugins', 'apps', 'hooks', 'skill_mcp_dependency_install']) assert(codex.args.includes(feature));
  assert(!codex.args.some(arg => arg.includes('bypass')));
  const claude = buildCliCommand({ harness: 'claude', cwd: '/tmp/project', toolsEnabled: false });
  assert(claude.args.includes('--restricted'));
  assert(claude.args.includes('Read,Glob,Grep'));
  assert(!claude.args.includes('Read,Glob,Grep,Write,Edit'));
});

test('Claude stream emits public deltas and tool events, drops thinking, and returns final answer', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of [
    { type: 'system', subtype: 'init', model: 'claude-test' },
    { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'private reasoning' } } },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Answer' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }, { type: 'tool_use', name: 'Read', id: 't1' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'result', result: 'Answer', usage: { output_tokens: 1 } }
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
});`);
  const events = [];
  const result = await runAgent({ harness: 'claude', cwd, prompt: 'hello', env: { ...process.env, SWARM_CLAUDE_BIN: binary }, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Answer');
  assert.equal(result.model, 'claude-test');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Answer');
  assert(!JSON.stringify(events).includes('private reasoning'));
  assert(events.some(event => event.type === 'tool' && event.status === 'completed'));
});

test('Codex JSONL returns the last public answer and ignores reasoning', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of [
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'private reasoning' } },
    { type: 'item.started', item: { id: 't1', type: 'command_execution', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 't1', type: 'command_execution', status: 'completed' } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Done' } },
    { type: 'turn.completed', usage: { output_tokens: 1 } }
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
});`);
  const events = [];
  const result = await runAgent({ harness: 'codex', cwd, prompt: 'hello', env: { ...process.env, SWARM_CODEX_BIN: binary }, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Done');
  assert(!JSON.stringify(events).includes('private reasoning'));
  assert(events.some(event => event.type === 'tool' && event.status === 'completed'));
});

test('adapter reports missing binary and redacts credentials in process errors', async t => {
  const cwd = await workspace(t);
  await assert.rejects(runAgent({ harness: 'claude', cwd, prompt: 'hello', env: { SWARM_CLAUDE_BIN: join(cwd, 'missing') } }), /ENOENT/);
  const binary = await fakeCli(t, cwd, `process.stderr.write('bad auth: ' + process.env.ANTHROPIC_API_KEY); process.exit(1);`);
  await assert.rejects(runAgent({ harness: 'claude', cwd, prompt: 'hello', env: { SWARM_CLAUDE_BIN: binary, ANTHROPIC_API_KEY: 'private-test-secret' } }), error => error.message.includes('[redacted]') && !error.message.includes('private-test-secret'));
});

test('each CLI receives only its own provider credentials', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
const text = JSON.stringify({anthropic: Boolean(process.env.ANTHROPIC_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY), litellm: Boolean(process.env.LITELLM_API_KEY)});
if (process.argv.includes('exec')) {
  process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'answer',text}})+'\\n');
  process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');
} else if (process.argv.includes('--mode')) {
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text}]}}));
  console.log(JSON.stringify({type:'agent_end'}));
} else if (process.argv.includes('run')) {
  console.log(JSON.stringify({type:'text',part:{id:'answer',text}}));
  console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}}));
} else process.stdout.write(JSON.stringify({type:'result',result:text})+'\\n');
`);
  const env = { SWARM_CLAUDE_BIN: binary, SWARM_CODEX_BIN: binary, SWARM_PI_BIN: binary, SWARM_OPENCODE_BIN: binary, ANTHROPIC_API_KEY: 'anthropic-test-secret', OPENAI_API_KEY: 'openai-test-secret', LITELLM_API_KEY: 'gateway-test-secret' };
  const claude = await runAgent({ harness: 'claude', cwd, prompt: 'hello', env });
  const codex = await runAgent({ harness: 'codex', cwd, prompt: 'hello', env });
  const codexAccount = await runAgent({ harness: 'codex', cwd, prompt: 'hello', env: { ...env, LITELLM_API_KEY: '' } });
  assert.deepEqual(JSON.parse(claude.text), { anthropic: true, openai: false, litellm: false });
  assert.deepEqual(JSON.parse(codex.text), { anthropic: false, openai: false, litellm: true });
  assert.deepEqual(JSON.parse(codexAccount.text), { anthropic: false, openai: true, litellm: false });
  for (const harness of ['pi', 'opencode']) {
    const result = await runAgent({ harness, cwd, prompt: 'hello', env });
    assert.deepEqual(JSON.parse(result.text), { anthropic: false, openai: false, litellm: true });
  }
});

test('timeout and caller cancellation stop a CLI without reporting completion', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `process.stdin.resume(); setInterval(() => {}, 1000);`);
  const options = { harness: 'claude', cwd, prompt: 'hello', env: { SWARM_CLAUDE_BIN: binary } };
  await assert.rejects(runAgent({ ...options, timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = runAgent({ ...options, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('User cancelled')), 100);
  await assert.rejects(pending, /User cancelled/);
});

test('timeout kills CLI descendants that ignore the initial termination signal', { skip: process.platform === 'win32' }, async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio: 'inherit'});
writeFileSync('descendant.pid', String(child.pid));
process.on('SIGTERM', () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  await assert.rejects(runAgent({ harness: 'claude', cwd, prompt: 'hello', env: { SWARM_CLAUDE_BIN: binary }, timeoutMs: 500 }), /timed out/);
  const descendant = Number(await readFile(join(cwd, 'descendant.pid'), 'utf8'));
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});

test('successful CLI completion also stops background descendants before profile cleanup', { skip: process.platform === 'win32' }, async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync('background.pid',String(child.pid));
console.log(JSON.stringify({type:'result',result:'Finished'}));
child.unref();
process.exit(0);
`);
  const result = await runAgent({ harness: 'claude', cwd, prompt: 'hello', env: { SWARM_CLAUDE_BIN: binary } });
  assert.equal(result.text, 'Finished');
  const background = Number(await readFile(join(cwd, 'background.pid'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.throws(() => process.kill(background, 0), { code: 'ESRCH' });
});

test('discovery checks executable availability without treating gateway env as verified access', async () => {
  const result = await availableHarnesses({ PATH: '', SWARM_CLAUDE_BIN: process.execPath, SWARM_PI_BIN: '/missing/swarm-pi', LITELLM_API_KEY: 'unverified' });
  assert.deepEqual(result, { native: { available: true, configured: true }, codex: { available: false }, claude: { available: true }, pi: { available: false, configured: true }, opencode: { available: false, configured: true } });
});

test('workspace tools protect private configuration but allow example environment files', async t => {
  const cwd = await workspace(t);
  for (const name of ['.env', '.env.local', '.env.example', '.env.sample']) await writeFile(join(cwd, name), 'configuration');
  for (const name of ['.ssh', '.aws', '.codex', '.agents']) await mkdir(join(cwd, name));
  for (const path of ['.env', '.env.local', '.ENV', '.ENV.LOCAL', '.ssh/id_rsa', '.aws/credentials', '.codex/config.toml', '.agents/config']) {
    await assert.rejects(executeWorkspaceTool(cwd, 'read_file', { path }), /protected/);
    await assert.rejects(executeWorkspaceTool(cwd, 'write_file', { path, content: 'replace' }), /protected/);
  }
  const entries = JSON.parse(await executeWorkspaceTool(cwd, 'list_files', { path: '.' })).entries;
  assert.deepEqual(entries.map(entry => entry.name), ['.env.example', '.env.sample']);
  assert.equal(await executeWorkspaceTool(cwd, 'read_file', { path: '.env.example' }), 'configuration');
});

test('Pi and OpenCode disable ambient tools and use only the isolated gateway profile', async t => {
  const cwd = await workspace(t);
  const env = { LITELLM_API_KEY: 'gateway-private-test-key' };
  const pi = buildCliCommand({ harness: 'pi', cwd, model: 'openai/gpt-6-astra', env });
  for (const option of ['--no-mcp', '--no-builtin-tools', '--no-extensions', '--no-context-files', '--no-session']) assert(pi.args.includes(option));
  assert(pi.args.includes('list_files,read_file'));
  const piProfile = await prepareHarnessProfile({ harness: 'pi', cwd, model: 'openai/gpt-6-astra', env, baseUrl: 'https://example.com/v1' });
  t.after(piProfile.cleanup);
  const modelsText = await readFile(join(piProfile.environment.PI_CODING_AGENT_DIR, 'models.json'), 'utf8');
  assert(!modelsText.includes(env.LITELLM_API_KEY));
  assert.equal(JSON.parse(modelsText).providers.swarm.apiKey, '${LITELLM_API_KEY}');
  assert.equal(piProfile.environment.SWARM_WORKSPACE_WRITE, '0');
  const profile = await prepareHarnessProfile({ harness: 'opencode', cwd, model: 'openai/gpt-6-astra', env, baseUrl: 'https://example.com/v1' });
  t.after(profile.cleanup);
  assert.equal(profile.environment.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  const config = JSON.parse(profile.environment.OPENCODE_CONFIG_CONTENT);
  assert(!profile.environment.OPENCODE_CONFIG_CONTENT.includes(env.LITELLM_API_KEY));
  assert.deepEqual(config.permission, { '*': 'deny', 'workspace_*': 'allow' });
  assert.deepEqual(config.agent.swarm.tools, { '*': false, 'workspace_*': true });
  assert.equal(config.mcp.workspace.environment.LITELLM_API_KEY, '');
  assert.equal(config.mcp.workspace.command.at(-1), 'read');
});

test('Codex gateway routing uses a validated Responses provider, scoped credentials and isolated config', async t => {
  const cwd = await workspace(t);
  const env = { LITELLM_API_KEY: 'gateway-private-test-key', LITELLM_BASE_URL: 'https://example.com/v1/' };
  const command = buildCliCommand({ harness: 'codex', cwd, model: 'gpt-6.1-sol', env });
  assert(command.args.includes('model_provider="swarm"'));
  assert(command.args.includes('model_providers.swarm.base_url="https://example.com/v1"'));
  assert(command.args.includes('model_providers.swarm.env_key="LITELLM_API_KEY"'));
  assert(command.args.includes('model_providers.swarm.wire_api="responses"'));
  assert(command.args.includes('openai/gpt-6.1-sol'));
  assert(!JSON.stringify(command).includes(env.LITELLM_API_KEY));
  assert.throws(() => buildCliCommand({ harness: 'codex', cwd, env: { ...env, LITELLM_BASE_URL: 'http://untrusted.example' } }), /HTTPS/);
  const profile = await prepareHarnessProfile({ harness: 'codex', cwd, env });
  assert.notEqual(profile.environment.CODEX_HOME, process.env.CODEX_HOME);
  await profile.cleanup();
  await assert.rejects(stat(profile.environment.CODEX_HOME), { code: 'ENOENT' });
});

test('Pi emits public streaming text, remembers tool paths and uses actual model identity', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
process.stdin.resume();
process.stdin.on('end', () => {
 for (const event of [
 {type:'agent_start'},
 {type:'message_start',message:{role:'assistant',model:'actual-model'}},
 {type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'private reasoning'}},
 {type:'tool_execution_start',toolCallId:'tool1',toolName:'read_file',args:{path:'input.txt'}},
 {type:'tool_execution_end',toolCallId:'tool1',toolName:'read_file'},
 {type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi answer'}},
 {type:'message_end',message:{role:'assistant',model:'actual-model',stopReason:'stop',content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:'Pi answer'}],usage:{input:10,output:2,totalTokens:12}}},
 {type:'agent_end',messages:[]}
 ]) console.log(JSON.stringify(event));
});`);
  const events = [];
  const result = await runAgent({ harness: 'pi', cwd, prompt: 'hello', env: { SWARM_PI_BIN: binary, LITELLM_API_KEY: 'test-gateway-key' }, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Pi answer');
  assert.equal(result.model, 'actual-model');
  assert.equal(result.usage.totalTokens, 12);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Pi answer');
  assert(!JSON.stringify(events).includes('private reasoning'));
  assert(events.some(event => event.type === 'tool' && event.status === 'completed' && event.path === 'input.txt'));
});

test('OpenCode parses cumulative public text and tool completion without exposing reasoning', async t => {
  const cwd = await workspace(t);
  const binary = await fakeCli(t, cwd, `
process.stdin.resume();
process.stdin.on('end', () => {
 for (const event of [
 {type:'step_start'},
 {type:'reasoning',part:{text:'private reasoning'}},
 {type:'tool_use',part:{id:'t1',tool:'workspace_read_file',state:{status:'completed',input:{path:'input.txt'}}}},
 {type:'step_finish',part:{reason:'tool-calls',tokens:{input:10,output:1}}},
 {type:'step_start'},
 {type:'text',part:{id:'m1',text:'Final'}},
 {type:'text',part:{id:'m1',text:'Final answer'}},
 {type:'step_finish',part:{reason:'stop',tokens:{input:12,output:2}}}
 ]) console.log(JSON.stringify(event));
});`);
  const events = [];
  const result = await runAgent({ harness: 'opencode', model: 'openai/gpt-6-astra', cwd, prompt: 'hello', env: { SWARM_OPENCODE_BIN: binary, LITELLM_API_KEY: 'test-gateway-key' }, onEvent: event => events.push(event) });
  assert.equal(result.text, 'Final answer');
  assert.equal(result.model, 'openai/gpt-6-astra');
  assert.equal(result.usage.input, 22);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Final answer');
  assert(!JSON.stringify(events).includes('private reasoning'));
  assert(events.some(event => event.type === 'tool' && event.status === 'completed' && event.path === 'input.txt'));
});

test('CLI command events include exit and output details while redacting every public string field', async t => {
  const cwd = await workspace(t);
  const secret = 'synthetic-cli-event-secret';
  const command = `printf ${secret}`;
  const events = [
    {type: 'tool_use', part: {id: 'command-1', tool: 'workspace_run_command', state: {status: 'running', input: {command}}}},
    {type: 'tool_use', part: {id: 'command-1', tool: 'workspace_run_command', state: {status: 'completed', input: {command}, output: JSON.stringify({stdout: secret, stderr: 'Failure evidence', exitCode: 2, timedOut: false, truncated: false})}}},
    {type: 'text', part: {id: 'answer-1', text: 'The command failed with a visible exit code.'}},
    {type: 'step_finish', part: {reason: 'stop'}},
  ];
  const binary = await fakeCli(t, cwd, `process.stdin.resume(); process.stdin.on('end', () => {for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));});`);
  const emitted = [];
  await runAgent({harness: 'opencode', cwd, prompt: 'Run the command', toolsEnabled: true, env: {LITELLM_API_KEY: secret, SWARM_OPENCODE_BIN: binary}, onEvent: event => emitted.push(event)});
  const result = emitted.find(event => event.type === 'tool' && event.exitCode === 2);
  assert.equal(result.status, 'error');
  assert.equal(result.command, 'printf [redacted]');
  assert.equal(result.stdout, '[redacted]');
  assert.equal(result.stderr, 'Failure evidence');
  assert(!JSON.stringify(emitted).includes(secret));
});

test('Claude reports an explicit local command server rejection instead of pretending action tools loaded', async t => {
  const cwd = await workspace(t);
  const events = [{type: 'system', subtype: 'init', model: 'claude-test', mcp_server_errors: [{name: 'swarm_actions', type: 'configuration', message: 'Local command server rejected'}]}, {type: 'result', result: 'I cannot execute commands'}];
  const binary = await fakeCli(t, cwd, `process.stdin.resume(); process.stdin.on('end', () => {for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));});`);
  await assert.rejects(runAgent({harness: 'claude', cwd, prompt: 'Perform actions', toolsEnabled: true, env: {SWARM_CLAUDE_BIN: binary}}), /local command server did not load.*rejected/);
});

test('new harnesses surface zero-exit upstream failures and clean profiles after cancellation', async t => {
  const cwd = await workspace(t);
  for (const harness of ['pi', 'opencode']) {
    await assert.rejects(runAgent({ harness, cwd, prompt: 'hello', env: {} }), /LITELLM_API_KEY/);
    const failure = harness === 'pi' ? [{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'authentication failed'}},{type:'agent_end'}] : [{type:'error',error:{data:{message:'authentication failed'}}}];
    const binary = await fakeCli(t, cwd, `for (const event of ${JSON.stringify(failure)}) console.log(JSON.stringify(event));`);
    const env = { [`SWARM_${harness.toUpperCase()}_BIN`]: binary, LITELLM_API_KEY: 'test-gateway-key' };
    await assert.rejects(runAgent({ harness, cwd, prompt: 'hello', env }), /authentication failed/);
    await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync('profile.txt', process.env.PI_CODING_AGENT_DIR || process.env.OPENCODE_TEST_HOME); process.stdin.resume(); setInterval(()=>{},1000);`);
    await assert.rejects(runAgent({ harness, cwd, prompt: 'hello', env, timeoutMs: 500 }), /timed out/);
    const profilePath = await readFile(join(cwd, 'profile.txt'), 'utf8');
    await assert.rejects(stat(profilePath), { code: 'ENOENT' });
  }
});
