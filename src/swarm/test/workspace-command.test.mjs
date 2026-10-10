import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {runWorkspaceCommand} from '../src/workspace-command.mjs';

const macOnly = {skip: process.platform !== 'darwin'};
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `${quote(process.execPath)} -e ${quote(source)}`;
const stubbornChild = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';

async function workspace(t) {
  const parent = await mkdtemp(join(tmpdir(), 'swarm-command-test-'));
  const cwd = join(parent, 'workspace');
  await mkdir(cwd);
  t.after(() => rm(parent, {recursive: true, force: true}));
  return {parent, cwd};
}

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Expected command lifecycle condition did not occur');
}

function alive(pid) {
  try {process.kill(pid, 0); return true;} catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('local commands create actual workspace artifacts and report exit diagnostics', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const result = await runWorkspaceCommand({cwd, command: 'printf "%s" "Verified local action" > artifact.txt; cat artifact.txt; printf "%s" "diagnostic" >&2; exit 7'});
  assert.equal(await readFile(join(cwd, 'artifact.txt'), 'utf8'), 'Verified local action');
  assert.equal(result.stdout, 'Verified local action');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test('commands start in the workspace with isolated home and without inference credentials', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const result = await runWorkspaceCommand({cwd, env: {PATH: process.env.PATH, HOME: '/original/private/home', LITELLM_API_KEY: 'local-test-key', ANTHROPIC_API_KEY: 'other-test-key', PROJECT_PASSWORD: 'private-test-value'},
    command: nodeCommand('console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,temporary:process.env.TMPDIR,key:process.env.LITELLM_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY,password:process.env.PROJECT_PASSWORD}))')});
  assert.equal(result.exitCode, 0);
  const environment = JSON.parse(result.stdout);
  assert.equal(environment.cwd, await realpath(cwd));
  assert.notEqual(environment.home, '/original/private/home');
  assert(environment.home);
  assert(environment.temporary);
  for (const key of ['key', 'anthropic', 'password']) assert.equal(environment[key], undefined);
  await assert.rejects(access(environment.home), {code: 'ENOENT'});
});

test('sandbox refuses writes outside the workspace, including through a symlink', macOnly, async (t) => {
  const {parent, cwd} = await workspace(t);
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'Keep this outside file');
  await symlink(outside, join(cwd, 'outside-link'));
  for (const destination of [outside, 'outside-link']) {
    const result = await runWorkspaceCommand({cwd, command: `printf changed > ${quote(destination)}`});
    assert.notEqual(result.exitCode, 0);
    assert.equal(await readFile(outside, 'utf8'), 'Keep this outside file');
  }
});

test('local commands protect private configuration and keep Git metadata read-only', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const paths = ['.env', '.git/config', '.swarm/state.json', '.ssh/private-key'];
  for (const path of paths) {
    if (path.includes('/')) await mkdir(join(cwd, path.split('/')[0]));
    await writeFile(join(cwd, path), 'Protected fixture value');
  }
  const source = `const fs=require('node:fs'); const paths=${JSON.stringify(paths)}; console.log(JSON.stringify(paths.map(path=>{let read=false,write=false;try{fs.readFileSync(path);read=true}catch{}try{fs.writeFileSync(path,'changed');write=true}catch{}return{path,read,write}})));`;
  const result = await runWorkspaceCommand({cwd, command: nodeCommand(source)});
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), paths.map((path) => ({path, read: path.startsWith('.git/'), write: false})));
  for (const path of paths) assert.equal(await readFile(join(cwd, path), 'utf8'), 'Protected fixture value');
});

test('command output is bounded across stdout and stderr', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  for (const source of ['process.stdout.write("x".repeat(80000));process.stderr.write("y".repeat(80000));', 'process.stdout.write("€".repeat(30000));']) {
    const result = await runWorkspaceCommand({cwd, command: nodeCommand(source)});
    assert.equal(result.truncated, true);
    assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 65536);
    assert(!result.stdout.includes('\uFFFD'));
  }
});

test('command sandbox blocks network connections even to a listening local service', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  let connections = 0;
  const server = createServer((socket) => {connections++; socket.destroy();});
  await new Promise((accept, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', accept);});
  t.after(() => new Promise((accept) => server.close(accept)));
  const source = `const socket=require('node:net').connect(${server.address().port},'127.0.0.1');socket.on('connect',()=>{console.log('connected');socket.destroy()});socket.on('error',error=>console.log(error.code));`;
  const result = await runWorkspaceCommand({cwd, command: nodeCommand(source)});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /EPERM|EACCES/);
  assert.equal(connections, 0);
});

test('command timeout kills descendants that ignore graceful termination', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const source = `const{spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(stubbornChild)}],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);`;
  let descendant;
  t.after(() => {if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');});
  const result = await runWorkspaceCommand({cwd, command: nodeCommand(source), timeoutMs: 800});
  assert.equal(result.timedOut, true, JSON.stringify(result));
  descendant = Number(await readFile(join(cwd, 'descendant.pid'), 'utf8'));
  await until(() => !alive(descendant));
});

test('caller cancellation waits for the running command to stop', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const controller = new AbortController();
  let pid;
  t.after(() => {if (pid && alive(pid)) process.kill(pid, 'SIGKILL');});
  const pending = runWorkspaceCommand({cwd, signal: controller.signal, command: nodeCommand('require("node:fs").writeFileSync("command.pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);')});
  await until(async () => {try {pid = Number(await readFile(join(cwd, 'command.pid'), 'utf8')); return pid > 0;} catch {return false;}});
  controller.abort(new Error('User stopped this work'));
  await assert.rejects(pending, /User stopped this work/);
  await until(() => !alive(pid));
});

test('cancelled commands never begin execution', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  const controller = new AbortController();
  controller.abort(new Error('Already stopped'));
  await assert.rejects(runWorkspaceCommand({cwd, command: 'printf changed > should-not-exist', signal: controller.signal}), /Already stopped/);
  await assert.rejects(readFile(join(cwd, 'should-not-exist')), {code: 'ENOENT'});
});

test('a deliberately detached process cannot hold the command result open through inherited pipes', macOnly, async (t) => {
  const {cwd} = await workspace(t);
  let detached;
  t.after(() => {if (detached && alive(detached)) process.kill(detached, 'SIGKILL');});
  const source = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(stubbornChild)}],{detached:true,stdio:'inherit'});require('node:fs').writeFileSync('detached.pid',String(child.pid));child.unref();`;
  const started = Date.now();
  const result = await runWorkspaceCommand({cwd, command: nodeCommand(source), timeoutMs: 5000});
  detached = Number(await readFile(join(cwd, 'detached.pid'), 'utf8'));
  assert(Date.now() - started < 2000);
  assert.equal(result.truncated, true);
  // Deliberate new process groups are not claimed to be contained by group cleanup.
  if (alive(detached)) process.kill(detached, 'SIGKILL');
});

test('MCP host closure stops active command descendants', macOnly, async (t) => {
  for (const method of ['stdin EOF', 'SIGTERM']) await t.test(method, async (t) => {
    const {cwd} = await workspace(t);
    const mcp = fileURLToPath(new URL('../src/workspace-mcp.mjs', import.meta.url));
    const host = spawn(process.execPath, [mcp, cwd, 'write'], {cwd, stdio: ['pipe', 'ignore', 'pipe']});
    let diagnostics = '';
    host.stderr.on('data', (bytes) => {diagnostics = (diagnostics + bytes).slice(-2000);});
    const closed = new Promise((accept, reject) => {host.once('error', reject); host.once('close', accept);});
    let pids = [];
    t.after(() => {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    const source = `const{spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(stubbornChild)}],{stdio:'inherit'});require('node:fs').writeFileSync('host-command.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    host.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'run_command', arguments: {command: nodeCommand(source)}}}) + '\n');
    await until(async () => {try {pids = JSON.parse(await readFile(join(cwd, 'host-command.json'), 'utf8')); return pids.length === 2;} catch {return false;}});
    if (method === 'stdin EOF') host.stdin.end();
    else host.kill('SIGTERM');
    const outcome = await Promise.race([closed.then(() => 'closed'), delay(3000, undefined, {ref: false}).then(() => 'still running')]);
    assert.equal(outcome, 'closed', diagnostics);
    await until(() => pids.every((pid) => !alive(pid)));
  });
});

test('unsupported platforms reject local commands instead of removing the sandbox', {skip: process.platform === 'darwin'}, async (t) => {
  const {cwd} = await workspace(t);
  await assert.rejects(runWorkspaceCommand({cwd, command: 'echo unsafe'}), /unsupported|macOS|sandbox/i);
});
