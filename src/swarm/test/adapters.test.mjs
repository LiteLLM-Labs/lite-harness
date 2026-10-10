import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableHarnesses, buildCliCommand, executeWorkspaceTool, gatewayUrl, parseSse, runAgent } from '../src/adapters.mjs';

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
      assert.equal(request.tools.length, 3);
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
    assert.match(request.messages.at(-1).content, /writes are disabled/);
    return streamResponse([{ choices: [{ index: 0, delta: { content: 'Writes disabled.' }, finish_reason: 'stop' }] }]);
  });
  await runAgent({ prompt: 'Read only', cwd, env: { LITELLM_API_KEY: 'test-secret-key' } });
  await assert.rejects(readFile(join(cwd, 'unexpected.txt')), { code: 'ENOENT' });
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
} else process.stdout.write(JSON.stringify({type:'result',result:text})+'\\n');
`);
  const env = { SWARM_CLAUDE_BIN: binary, SWARM_CODEX_BIN: binary, ANTHROPIC_API_KEY: 'anthropic-test-secret', OPENAI_API_KEY: 'openai-test-secret', LITELLM_API_KEY: 'gateway-test-secret' };
  const claude = await runAgent({ harness: 'claude', cwd, prompt: 'hello', env });
  const codex = await runAgent({ harness: 'codex', cwd, prompt: 'hello', env });
  assert.deepEqual(JSON.parse(claude.text), { anthropic: true, openai: false, litellm: false });
  assert.deepEqual(JSON.parse(codex.text), { anthropic: false, openai: true, litellm: false });
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

test('discovery checks executable availability without treating gateway env as verified access', async () => {
  const result = await availableHarnesses({ PATH: '', SWARM_CLAUDE_BIN: process.execPath, LITELLM_API_KEY: 'unverified' });
  assert.deepEqual(result, { native: { available: true, configured: true }, codex: { available: false }, claude: { available: true } });
});
