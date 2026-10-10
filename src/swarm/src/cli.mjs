import {parseArgs, parseEnv} from 'node:util';
import {readFileSync, writeFileSync, existsSync, realpathSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {RunStore} from './store.mjs';
import {SwarmRunner} from './runner.mjs';
import {startServer} from './server.mjs';
import {defaultTeam, defaultModel, HARNESSES} from './team.mjs';
import {availableHarnesses, gatewayUrl} from './adapters.mjs';

const HELP = `
  ◌ swarm  ·  one task, a team of agents

  swarm run "Your task"           Run a swarm in this terminal
  swarm run "Your task" --open    Open its live constellation
  swarm demo --open               Try the simulated demo, no key needed
  swarm ui                        Open a local workspace
  swarm list                      List saved runs
  swarm logs [run-id]              Read the full public conversation
  swarm models                    List models on your LiteLLM gateway
  swarm doctor                    Check installed harnesses
  swarm init                      Write an editable swarm.json team

  --harness native|codex|claude    Harness for the default team (native)
  --model NAME                    Gateway alias or harness model
  --config FILE                   Team configuration (see swarm init)
  --cwd DIRECTORY                 Project the agents can inspect
  --tools                         Allow file writes (default: read-only)
  --timeout SECONDS               Whole-swarm limit (default: 600)
  --data-dir DIRECTORY            Saved runs (default: .swarm/runs)
  --port PORT                     Local view port (default: 4318)
  --follow-up RUN-ID              Include the previous task and answer
  --env-file FILE                 Read local gateway settings privately
  --json                          Newline-delimited events for scripts

  LITELLM_API_KEY / LITELLM_MODEL / LITELLM_BASE_URL
  Default gateway: https://gateway-dev.litellm-sandbox.ai

  While running: type a direction + Enter; /stop to cancel.
  Directions reach agents that have not started their contribution.
`;

// Model output is untrusted terminal content; preserve line breaks, not escapes.
const plain = (text) => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const say = (text = '') => process.stdout.write(`${plain(text)}\n`);

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], {stdio: 'ignore', detached: true});
  child.on('error', () => say(`Open ${url} in your browser.`));
  child.unref();
}

async function models() {
  if (!process.env.LITELLM_API_KEY) throw new Error('Set LITELLM_API_KEY first.');
  const response = await fetch(gatewayUrl(process.env.LITELLM_BASE_URL, 'models'), {headers: {Authorization: `Bearer ${process.env.LITELLM_API_KEY}`}, signal: AbortSignal.timeout(20000), redirect: 'error'});
  if (!response.ok) throw new Error(`Gateway model discovery returned HTTP ${response.status}. Check the key and gateway URL.`);
  const body = await response.json();
  for (const model of body.data || []) say(model.id);
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'}, open: {type: 'boolean'}, json: {type: 'boolean'}, tools: {type: 'boolean'},
    model: {type: 'string'}, harness: {type: 'string'}, config: {type: 'string'}, cwd: {type: 'string'}, timeout: {type: 'string'}, port: {type: 'string'},
    'data-dir': {type: 'string'}, 'follow-up': {type: 'string'}, 'env-file': {type: 'string'},
  }});
  if (values['env-file']) {
    const local = parseEnv(readFileSync(resolve(values['env-file']), 'utf8'));
    for (const name of ['LITELLM_API_KEY', 'LITELLM_BASE_URL', 'LITELLM_MODEL']) if (local[name] !== undefined) process.env[name] = local[name];
  }
  if (values.version) return say('swarm 0.1.0');
  if (values.help || !positionals.length) return say(HELP);
  const commands = ['run', 'demo', 'ui', 'list', 'logs', 'models', 'doctor', 'init'];
  const command = commands.includes(positionals[0]) ? positionals.shift() : 'run';
  if (command === 'models') return models();
  if (command === 'doctor') {
    const harnesses = await availableHarnesses();
    say(`Node ${process.version}`);
    for (const [id, info] of Object.entries(harnesses)) say(`${info.available ? '✓' : '·'} ${id}${id === 'native' ? ` · gateway key ${info.configured ? 'present (not validated)' : 'missing'}` : info.available ? ' · installed' : ' · not installed'}`);
    return;
  }
  const workspace = realpathSync(resolve(values.cwd || process.cwd()));
  if (command === 'init') {
    const destination = join(workspace, 'swarm.json');
    if (existsSync(destination)) throw new Error('swarm.json already exists. Edit it to configure your team.');
    writeFileSync(destination, JSON.stringify({agents: defaultTeam(), timeoutSeconds: 600}, null, 2) + '\n', {flag: 'wx'});
    return say(`Created ${destination}`);
  }
  const store = new RunStore(resolve(values['data-dir'] || join(workspace, '.swarm', 'runs')));
  if (command === 'list') {
    for (const run of store.list()) say(`${run.id}  ${run.status.padEnd(11)} ${run.demo ? '[demo] ' : ''}${run.task}`);
    return;
  }
  if (command === 'logs') {
    const run = positionals[0] ? store.get(positionals[0]) : store.list()[0];
    if (!run) throw new Error('No saved run found.');
    if (values.json) return say(JSON.stringify(run));
    say(`◌ ${run.task}\n${run.status}${run.demo ? ' · simulated demo' : ''}`);
    for (const event of run.events) {
      const agent = run.agents.find((item) => item.id === event.agentId);
      const label = event.agentId === 'user' ? 'You' : agent ? `${agent.name} · ${agent.harness}` : 'swarm';
      say(`\n${label} · ${event.type}\n${event.text}`);
    }
    for (const agent of run.agents.filter((item) => item.status !== 'complete' && item.output)) say(`\n${agent.name} · partial output\n${agent.output}`);
    return;
  }
  let options = values.config ? JSON.parse(readFileSync(resolve(values.config), 'utf8')) : {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Config must be a JSON object.');
  if (values.harness && !HARNESSES.includes(values.harness)) throw new Error(`Unknown harness: ${values.harness}`);
  if (values.harness || values.model) {
    const harness = values.harness || 'native';
    options = {...options, agents: defaultTeam({harness, model: values.model ?? defaultModel(harness)})};
  }
  options = {...options, task: positionals.join(' '), demo: command === 'demo', parentId: values['follow-up'], toolsEnabled: values.tools ?? options.toolsEnabled ?? false};
  if (values.timeout) options.timeoutSeconds = Number(values.timeout);
  const port = Number(values.port || 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
  const release = store.acquire();
  store.recover();
  const runner = new SwarmRunner({store, workspace});
  if (command === 'ui') runner.run = store.list()[0] || null;
  let server;
  let input;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    runner.stop();
    await runner.done;
    input?.close();
    await server?.close();
    release();
  };
  process.once('exit', release);
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  try {
    if (values.open || command === 'ui') {
      server = await startServer({runner, store, port});
      if (values.json) say(JSON.stringify({type: 'server', url: server.url}));
      else say(`\n  ◌ swarm  ·  ${server.url}\n`);
      if (values.open) openBrowser(server.url);
    }
    runner.on('event', (event) => {
      if (values.json) return say(JSON.stringify(event));
      const agent = runner.run.agents.find((item) => item.id === event.agentId);
      const label = agent ? `${agent.name} · ${agent.harness}` : 'swarm';
      if (event.type === 'status') say(`  ${agent?.status === 'complete' ? '✓' : '·'} ${label}  ${event.text}`);
      if (event.type === 'tool') say(`  ↳ ${label}  ${event.text}`);
      if (event.type === 'message' && agent) say(`\n  ${label}\n${event.text}\n`);
    });
    runner.on('delta', (event) => {if (values.json) say(JSON.stringify({type: 'delta', ...event}));});
    if (process.stdin.isTTY) {
      input = createInterface({input: process.stdin, output: process.stdout, terminal: true});
      input.on('line', (line) => {
        if (line.trim() === '/stop') return runner.stop();
        if (line.trim() === '/quit') return void shutdown();
        if (!line.trim()) return;
        try {runner.steer(line);} catch (error) {say(error.message);}
      });
    }
    if (command !== 'ui') {
      runner.start(options);
      if (!values.json) say(`  ${runner.run.demo ? 'DEMO · simulated · no inference' : `${runner.run.agents.length} agents · read${runner.run.toolsEnabled ? '/write' : '-only'} workspace`}\n`);
      await runner.done;
      process.exitCode = runner.run.status === 'complete' ? 0 : 1;
      if (!values.json) say(`  Saved ${runner.run.id}${server ? '\n  The view stays open. Ctrl+C to exit.' : ''}`);
    }
    if (!server) await shutdown();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

export async function runCli() {
  await main().catch((error) => {process.stderr.write(`swarm: ${plain(error.message)}\n`); process.exitCode = 1;});
}
