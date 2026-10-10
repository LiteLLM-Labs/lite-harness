import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {request} from 'node:http';
import {RunStore} from '../src/store.mjs';
import {SwarmRunner} from '../src/runner.mjs';
import {startServer} from '../src/server.mjs';
import {defaultTeam, MAX_AGENTS} from '../src/team.mjs';

function manualClock() {
  let now = 1000000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {const id = ++sequence; timers.set(id, {callback, at: now + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = target;
    },
  };
}

async function until(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(2);
  }
  assert.fail('Expected chat lifecycle condition did not occur');
}

async function chatFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-chat-http-'));
  const store = new RunStore(directory);
  const clock = manualClock();
  const calls = [];
  const agents = ['alpha', 'beta'].map((id) => ({id, name: id, role: 'Choose useful work', harness: 'native', model: 'test-model'}));
  const runner = new SwarmRunner({store, workspace: directory, clock, adapter: async (args) => {
    if (args.phase === 'election') return {text: JSON.stringify({candidateId: 'alpha', identity: {name: `Chosen ${args.id}`, role: 'Investigate the task'}})};
    const task = args.prompt.match(/User task:\n([\s\S]*?)\n\nCurrent assignment:/)?.[1];
    calls.push({task, prompt: args.prompt});
    args.onEvent({type: 'delta', text: `Public progress for ${task}`});
    await delay(2, undefined, {signal: args.signal});
    return {text: JSON.stringify({text: `Contribution for ${task}`, result: `ANSWER_MARKER:${task}`, proposal: {id: 'evidence', text: `Proposal for ${task}`}})};
  }});
  const server = await startServer({runner, store, port: 0, capabilities: []});
  t.after(async () => {runner.stop(); await runner.done; await server.close(); rmSync(directory, {recursive: true, force: true});});
  const headers = {Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json'};
  const get = (path) => fetch(`${server.url}${path}`, {headers});
  const post = (path, body = {}) => fetch(`${server.url}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
  const start = async (task, options = {}) => {
    const response = await post('/api/run', {task, agents, timeoutSeconds: 5, ...options});
    assert.equal(response.status, 201);
    return response.json();
  };
  return {runner, store, clock, calls, agents, get, post, start, server};
}

test('HTTP view runs, streams, steers, stops, and persists a swarm with origin protection', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-http-'));
  const store = new RunStore(directory);
  const runner = new SwarmRunner({store, adapter: async ({signal}) => {await delay(5000, undefined, {signal}); return {text: 'done'};}});
  const server = await startServer({runner, store, port: 0, capabilities: []});
  t.after(async () => {runner.stop(); await runner.done; await server.close(); rmSync(directory, {recursive: true, force: true});});
  const auth = {Authorization: `Bearer ${server.token}`};
  const get = (path) => fetch(`${server.url}${path}`, {headers: auth});
  const post = (path, body, headers = {}) => fetch(`${server.url}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', ...auth, ...headers}, body: JSON.stringify(body)});
  assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${server.url}/session.js`, {headers: {'Sec-Fetch-Site': 'same-site'}})).status, 403);
  const bootstrap = await fetch(`${server.url}/session.js`);
  assert.equal(bootstrap.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(await bootstrap.text(), /__SWARM_TOKEN/);
  assert.equal((await post('/api/run', {task: 'evil'}, {Origin: 'https://outside.example'})).status, 403);
  assert.equal((await post('/api/run', {task: 'evil'}, {'Sec-Fetch-Site': 'cross-site'})).status, 403);
  const rejectedStatus = await new Promise((accept, reject) => {
    const outgoing = request(`${server.url}/api/state`, {headers: {Host: 'outside.example'}}, (response) => {response.resume(); accept(response.statusCode);});
    outgoing.on('error', reject); outgoing.end();
  });
  assert.equal(rejectedStatus, 403);
  const start = await post('/api/run', {task: 'Do useful work'});
  assert.equal(start.status, 201);
  const run = await start.json();
  const stream = await get('/api/events');
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: state/);
  await reader.cancel();
  assert.equal((await post('/api/message', {text: 'Focus on speed'})).status, 200);
  assert.equal((await post('/api/stop', {})).status, 200);
  const saved = await (await get(`/api/runs/${run.id}`)).json();
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.directions[0], 'Focus on speed');
  const state = await (await get('/api/state')).json();
  assert.equal(state.runs.length, 1);
  assert.equal(state.defaults.team.length, 10);
  assert.deepEqual([...new Set(state.defaults.team.map((peer) => peer.harness))].sort(), ['claude', 'codex', 'opencode', 'pi']);
  assert.equal(state.defaults.harnessModels.codex, 'gpt-6.1-sol');
  assert.equal(state.defaults.duration, 600);
  assert.equal(state.run.status, 'stopped');
  assert.equal((await get('/api/runs/not-an-id')).status, 404);
  assert.equal((await post('/api/run', {task: 'ok', agents: []})).status, 400);
});

test('new chats reset state after completed or stopped runs and retain both histories without a subscriber', async (t) => {
  for (const terminalStatus of ['complete', 'stopped']) await t.test(terminalStatus, async (t) => {
    const {runner, clock, agents, get, post, start, calls} = await chatFixture(t);
    const first = await start('FIRST_CHAT_UNIQUE');
    await until(() => runner.run.results.length > 0 && runner.run.proposals.length > 0);
    assert.equal((await post('/api/message', {text: 'FIRST_DIRECTION_UNIQUE'})).status, 200);
    if (terminalStatus === 'complete') {clock.advance(5000); await runner.done;}
    else assert.equal((await post('/api/stop')).status, 200);
    const previous = await (await get(`/api/runs/${first.id}`)).json();
    assert.equal(previous.status, terminalStatus);
    assert.match(previous.result, /ANSWER_MARKER:FIRST_CHAT_UNIQUE/);

    // No state request or SSE subscription has populated the server history cache.
    const fresh = await start('SECOND_CHAT_UNIQUE');
    assert.notEqual(fresh.id, first.id);
    assert.equal(fresh.parentId, null);
    assert.equal(fresh.result, '');
    for (const field of ['directions', 'results', 'proposals', 'coordinatorChanges']) assert.deepEqual(fresh[field], []);
    assert.deepEqual(fresh.agents.map(({name}) => name), agents.map(({name}) => name));
    assert(fresh.agents.every((agent) => agent.cycles === 0 && agent.failures === 0 && agent.transcript === '' && agent.output === '' && agent.lastContribution === ''));
    assert(!JSON.stringify(fresh).includes('FIRST_CHAT_UNIQUE'));
    assert(!JSON.stringify(fresh).includes('FIRST_DIRECTION_UNIQUE'));
    await until(() => calls.some(({task}) => task === fresh.task));
    for (const {prompt} of calls.filter(({task}) => task === fresh.task)) {
      assert(!prompt.includes('FIRST_CHAT_UNIQUE'));
      assert(!prompt.includes('FIRST_DIRECTION_UNIQUE'));
      assert(!prompt.includes('Previous result:'));
    }
    assert.equal((await post('/api/stop')).status, 200);
    const state = await (await get('/api/state')).json();
    assert.equal(state.run.id, fresh.id);
    assert.deepEqual(state.runs.map(({id}) => id), [fresh.id, first.id]);
    assert.equal(state.runs.find(({id}) => id === first.id).status, terminalStatus);
    assert.deepEqual(await (await get(`/api/runs/${first.id}`)).json(), previous);
  });
});

test('reading a live run returns unpersisted public progress without changing the selected chat', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-live-read-'));
  const store = new RunStore(directory);
  const clock = manualClock();
  const runner = new SwarmRunner({store, workspace: directory, clock, adapter: async ({phase, id, onEvent, signal}) => {
    if (phase === 'election') return {text: JSON.stringify({candidateId: 'peer-01'})};
    onEvent({type: 'delta', text: `Unpersisted evidence from ${id}`});
    await delay(10000, undefined, {signal});
    return {text: 'Should remain pending until stopped'};
  }});
  const server = await startServer({runner, store, port: 0, capabilities: []});
  t.after(async () => {await server.close(); rmSync(directory, {recursive: true, force: true});});
  const headers = {Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json'};
  const start = async (task) => {
    const response = await fetch(`${server.url}/api/run`, {method: 'POST', headers, body: JSON.stringify({task, agentCount: 2, timeoutSeconds: 5})});
    assert.equal(response.status, 201);
    return response.json();
  };
  const first = await start('Read this background chat');
  await until(() => runner.run.agents.every((agent) => agent.currentOutput));
  const second = await start('Keep this chat selected');
  assert(store.get(first.id).agents.every((agent) => agent.currentOutput === ''));
  const response = await fetch(`${server.url}/api/runs/${first.id}`, {headers});
  assert.equal(response.status, 200);
  const live = await response.json();
  assert.equal(live.id, first.id);
  assert(live.agents.every((agent) => agent.currentOutput === `Unpersisted evidence from ${agent.id}`));
  assert.equal(server.conversations.run.id, second.id);
  assert(store.get(first.id).agents.every((agent) => agent.currentOutput === ''));
  assert.equal((await fetch(`${server.url}/api/runs/missing-run`, {headers})).status, 404);
  clock.advance(100);
  assert.deepEqual(store.get(first.id).agents.map(({currentOutput}) => currentOutput), live.agents.map(({currentOutput}) => currentOutput));
});

test('only explicit parentId continues a prior answer, while each API chat stays independently saved', async (t) => {
  const {runner, calls, store, get, post, start} = await chatFixture(t);
  const first = await start('SOURCE_CHAT_UNIQUE');
  await until(() => runner.run.results.length > 0);
  await post('/api/stop');
  const firstSaved = await (await get(`/api/runs/${first.id}`)).json();
  const independent = await start('UNRELATED_CHAT_UNIQUE');
  await until(() => calls.some(({task}) => task === independent.task));
  await post('/api/stop');
  assert(calls.filter(({task}) => task === independent.task).every(({prompt}) => !prompt.includes('SOURCE_CHAT_UNIQUE') && !prompt.includes('Previous result:')));
  const rejected = await post('/api/run', {task: 'Invalid continuation', parentId: '00000000-0000-0000-0000-000000000000'});
  assert.equal(rejected.status, 400);
  assert.equal(store.list().length, 2);

  const continuation = await start('EXPLICIT_FOLLOWUP_UNIQUE', {parentId: first.id});
  assert.equal(continuation.parentId, first.id);
  assert.equal(continuation.result, '');
  assert.deepEqual(continuation.directions, []);
  await until(() => calls.some(({task}) => task === continuation.task));
  for (const {prompt} of calls.filter(({task}) => task === continuation.task)) {
    assert.match(prompt, /Previous task:\nSOURCE_CHAT_UNIQUE/);
    assert(prompt.includes(`Previous result:\n${firstSaved.result}`));
    assert(!prompt.includes('UNRELATED_CHAT_UNIQUE'));
  }
  await post('/api/stop');
  const state = await (await get('/api/state')).json();
  assert.deepEqual(state.runs.map(({id}) => id), [continuation.id, independent.id, first.id]);
  assert.deepEqual(await (await get(`/api/runs/${first.id}`)).json(), firstSaved);
  assert.equal((await (await get(`/api/runs/${independent.id}`)).json()).parentId, null);
  assert.equal((await (await get(`/api/runs/${continuation.id}`)).json()).parentId, first.id);

  // Reopening the view restores every saved chat and keeps the seeded selection first.
  const reopenedRunner = new SwarmRunner({store});
  reopenedRunner.run = store.get(continuation.id);
  const reopened = await startServer({runner: reopenedRunner, store, port: 0, capabilities: []});
  try {
    const restored = await (await fetch(`${reopened.url}/api/state`, {headers: {Authorization: `Bearer ${reopened.token}`}})).json();
    assert.equal(restored.run.id, continuation.id);
    assert.equal(restored.runs[0].id, continuation.id);
    assert.deepEqual(new Set(restored.runs.map(({id}) => id)), new Set([continuation.id, independent.id, first.id]));
  } finally {await reopened.close();}
});

test('independent active chats can be selected, steered and stopped without affecting their neighbors', async (t) => {
  const {calls, get, post, start, server} = await chatFixture(t);
  const first = await start('CONCURRENT_FIRST');
  const second = await start('CONCURRENT_SECOND');
  await until(() => [first.task, second.task].every((task) => calls.some((call) => call.task === task)));
  let state = await (await get('/api/state')).json();
  assert.equal(state.run.id, second.id);
  assert.equal(state.runs.filter(({status}) => status === 'running').length, 2);
  assert.equal((await post('/api/message', {text: 'ONLY_SECOND'})).status, 200);
  assert.equal((await post('/api/message', {text: 'ONLY_FIRST', runId: first.id})).status, 200);
  const firstLive = await (await post('/api/select', {id: first.id})).json();
  assert.deepEqual(firstLive.directions, ['ONLY_FIRST']);
  assert.equal((await post('/api/select', {id: 'missing-chat'})).status, 404);
  assert.equal((await post('/api/select')).status, 400);
  assert.equal((await (await get('/api/state')).json()).run.id, first.id);
  const stoppedFirst = await (await post('/api/stop')).json();
  assert.equal(stoppedFirst.id, first.id);
  assert.equal(stoppedFirst.status, 'stopped');
  const secondLive = await (await post('/api/select', {id: second.id})).json();
  assert.equal(secondLive.status, 'running');
  assert.deepEqual(secondLive.directions, ['ONLY_SECOND']);
  assert.equal((await post('/api/select', {id: first.id})).status, 200);
  assert.equal((await post('/api/message', {text: 'Cannot steer saved chat'})).status, 409);
  assert.equal((await post('/api/stop')).status, 200);
  assert.equal((await (await get('/api/state')).json()).runs.find(({id}) => id === second.id).status, 'running');

  // Updating an unselected chat must broadcast its status without changing selection.
  const stream = await fetch(`${server.url}/api/events`, {headers: {Authorization: `Bearer ${server.token}`}, signal: AbortSignal.timeout(3000)});
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function nextState() {
    for (;;) {
      const split = pending.indexOf('\n\n');
      if (split >= 0) {
        const frame = pending.slice(0, split); pending = pending.slice(split + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const {value, done} = await reader.read();
        assert.equal(done, false);
        pending += decoder.decode(value, {stream: true});
      }
    }
  }
  try {
    assert.equal((await nextState()).run.id, first.id);
    const stoppedSecond = await (await post('/api/stop', {runId: second.id})).json();
    assert.equal(stoppedSecond.id, second.id);
    do {state = await nextState();} while (state.runs.find(({id}) => id === second.id).status !== 'stopped');
    assert.equal(state.run.id, first.id);
    assert(state.runs.every(({status}) => status === 'stopped'));
  } finally {await reader.cancel();}
});

test('the active-chat limit is explicit, stopped slots reopen, and server shutdown waits for every chat', async (t) => {
  const {post, start, server, store} = await chatFixture(t);
  const started = await Promise.all(Array.from({length: 4}, (_, index) => start(`ACTIVE_CHAT_${index}`)));
  const limited = await post('/api/run', {task: 'One too many'});
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /4 chats/);
  assert.equal(store.list().length, 4);
  assert.equal((await post('/api/stop', {runId: started[0].id})).status, 200);
  const replacement = await start('REPLACEMENT_CHAT');
  const runners = [...started, replacement].map(({id}) => server.conversations.getRunner(id));
  await server.close();
  assert(runners.every((runner) => !runner.busy));
  assert.equal(store.list().length, 5);
  assert(store.list().every(({status, endedAt}) => status === 'stopped' && endedAt !== null));
});

test('the original CLI runner is observed when it starts before or after the server', async (t) => {
  const {runner, agents, get, post, server, store} = await chatFixture(t);
  const first = runner.start({task: 'CLI started after server', agents, timeoutSeconds: 5});
  assert.equal((await (await get('/api/state')).json()).run.id, first.id);
  await post('/api/stop', {runId: first.id});
  const second = runner.start({task: 'CLI started again', agents, timeoutSeconds: 5});
  const view = await (await get('/api/state')).json();
  assert.equal(view.run.id, second.id);
  assert.equal(view.runs.find(({id}) => id === first.id).status, 'stopped');

  const secondView = await startServer({runner, store, port: 0, capabilities: []});
  try {
    const attached = await (await fetch(`${secondView.url}/api/state`, {headers: {Authorization: `Bearer ${secondView.token}`}})).json();
    assert.equal(attached.run.id, second.id);
    assert.equal(attached.run.status, 'running');
  } finally {await secondView.close();}
  assert.equal(server.conversations.getRunner(second.id).busy, false);
});

test('manager forwards public events and deltas with their chat identity and detaches on close', async (t) => {
  const {server, start, calls} = await chatFixture(t);
  const events = [];
  const deltas = [];
  server.conversations.on('event', (event, run) => events.push({event, run}));
  server.conversations.on('delta', (event, run) => deltas.push({event, run}));
  const first = await start('FIRST_TERMINAL_CHAT');
  const second = await start('SECOND_TERMINAL_CHAT');
  await until(() => [first.task, second.task].every((task) => calls.some((call) => call.task === task)));
  for (const {id, task} of [first, second]) {
    assert(events.some(({event, run}) => event.runId === id && run.id === id && run.task === task));
    assert(deltas.some(({event, run}) => event.runId === id && run.id === id && event.text === `Public progress for ${task}`));
  }
  const runners = [first, second].map(({id}) => server.conversations.getRunner(id));
  await server.close();
  for (const runner of runners) for (const type of ['event', 'delta', 'state']) assert.equal(runner.listenerCount(type), 0);
});

test('adding peers targets one live chat and preserves its leader, deadline and neighboring chat', async (t) => {
  const {get, post, start, server} = await chatFixture(t);
  const first = await start('GROW_THIS_TEAM');
  const second = await start('KEEP_THIS_TEAM');
  const firstRunner = server.conversations.getRunner(first.id);
  await until(() => firstRunner.run.phase === 'working');
  const leader = firstRunner.run.coordinatorId;
  const response = await post('/api/agents', {runId: first.id, count: 13});
  assert.equal(response.status, 200);
  const grown = await response.json();
  assert.equal(grown.id, first.id);
  assert.equal(grown.agents.length, 15);
  assert.equal(grown.coordinatorId, leader);
  assert.equal(grown.deadlineAt, first.deadlineAt);
  assert.equal(grown.election.eligibleVoters, 2);
  assert.equal(new Set(grown.agents.map(({id}) => id)).size, 15);
  await until(() => firstRunner.run.agents.every(({cycles}) => cycles > 0));
  const state = await (await get('/api/state')).json();
  assert.equal(state.run.id, second.id);
  assert.equal(state.run.agents.length, 2);
  assert.equal(state.defaults.maxAgents, MAX_AGENTS);
  for (const count of [0, -1, 1.5, MAX_AGENTS]) {
    assert.equal((await post('/api/agents', {runId: first.id, count})).status, 400);
    assert.equal(firstRunner.run.agents.length, 15);
  }
  assert.equal((await post('/api/agents', {runId: 'missing', count: 1})).status, 404);
  const unauthenticated = await fetch(`${server.url}/api/agents`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({count: 1})});
  assert.equal(unauthenticated.status, 401);
  await post('/api/stop', {runId: first.id});
  assert.equal((await post('/api/agents', {runId: first.id, count: 1})).status, 409);
  assert.equal(server.conversations.getRunner(second.id).run.status, 'running');
});

test('API accepts initial teams beyond twelve and bounded large custom configurations', async (t) => {
  const {get, post, start, server} = await chatFixture(t);
  const generated = await start('GENERATED_THIRTY', {agents: undefined, agentCount: 30});
  assert.equal(generated.agents.length, 30);
  await post('/api/stop', {runId: generated.id});
  const agents = defaultTeam({count: MAX_AGENTS}).map((agent) => ({...agent, role: 'Discuss evidence. '.repeat(100)}));
  assert(Buffer.byteLength(JSON.stringify(agents)) > 64000);
  const custom = await start('LARGE_CUSTOM_TEAM', {agents});
  assert.equal(custom.agents.length, MAX_AGENTS);
  await post('/api/stop', {runId: custom.id});
  const bad = await post('/api/run', {task: 'Beyond maximum', agentCount: MAX_AGENTS + 1});
  assert.equal(bad.status, 400);
  const state = await (await get('/api/state')).json();
  assert.equal(state.runs.length, 2);
  const oversized = await fetch(`${server.url}/api/run`, {method: 'POST', headers: {Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({task: 'x'.repeat(2 * 1024 * 1024)})});
  assert.equal(oversized.status, 400);
});
