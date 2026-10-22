import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SwarmRunner} from '../src/runner.mjs';
import {RunStore} from '../src/store.mjs';
import {startServer} from '../src/server.mjs';

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
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await delay(2);
  }
  assert.fail('Expected access lifecycle condition did not occur');
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-access-test-'));
  const store = new RunStore(directory);
  const clock = manualClock();
  const calls = [];
  const cleanup = [];
  const agents = ['alpha', 'beta'].map((id) => ({id, name: id, role: 'Choose useful work', harness: 'native', model: 'test-model'}));
  const adapter = (args) => {
    const call = {args};
    calls.push(call);
    if (args.phase === 'election') return Promise.resolve({text: JSON.stringify({candidateId: 'alpha'})});
    return new Promise((accept, reject) => {
      const abort = () => reject(args.signal.reason);
      args.signal.addEventListener('abort', abort, {once: true});
      call.complete = () => {
        args.signal.removeEventListener('abort', abort);
        accept({text: JSON.stringify({text: `Verified contribution ${args.id}/${args.cycle}`, result: `Public answer ${args.cycle}`})});
      };
      if (args.signal.aborted) abort();
    });
  };
  const runner = new SwarmRunner({store, workspace: directory, clock, adapter});
  t.after(async () => {for (const close of cleanup) await close(); runner.stop(); await runner.done; rmSync(directory, {recursive: true, force: true});});
  const start = (options = {}) => runner.start({task: 'Work with live access settings', agents, timeoutSeconds: 5, ...options});
  const work = (id, cycle) => calls.find(({args}) => args.phase === 'work' && args.id === id && args.cycle === cycle);
  return {directory, store, clock, calls, agents, runner, start, work, cleanup};
}

test('live access affects the next invocation while preserving in-flight work, history, leader and deadline', async (t) => {
  const {runner, clock, calls, start, work} = fixture(t);
  start({toolsEnabled: false});
  await until(() => work('alpha', 1) && work('beta', 1));
  work('alpha', 1).complete();
  await until(() => work('alpha', 2));
  runner.steer('Keep the established evidence');
  clock.advance(100);
  const before = structuredClone(runner.run);

  runner.setAccess({toolsEnabled: true});
  assert.equal(runner.run.toolsEnabled, true);
  assert.equal(runner.run.id, before.id);
  assert.equal(runner.run.startedAt, before.startedAt);
  assert.equal(runner.run.deadlineAt, before.deadlineAt);
  assert.equal(runner.run.coordinatorId, before.coordinatorId);
  assert.deepEqual(runner.run.election, before.election);
  assert.deepEqual(runner.run.directions, before.directions);
  assert.deepEqual(runner.run.results, before.results);
  assert.deepEqual(runner.run.messages.slice(0, before.messages.length), before.messages);
  assert.deepEqual(runner.run.agents.map(({cycles}) => cycles), before.agents.map(({cycles}) => cycles));
  for (const call of [work('alpha', 2), work('beta', 1)]) {
    assert.equal(call.args.toolsEnabled, false);
    assert.equal(call.args.signal.aborted, false);
  }
  assert(calls.filter(({args}) => args.phase === 'election').every(({args}) => args.toolsEnabled === false));

  work('alpha', 2).complete();
  await until(() => work('alpha', 3));
  assert.equal(work('alpha', 3).args.toolsEnabled, true);
  runner.setAccess({toolsEnabled: false});
  assert.equal(runner.run.toolsEnabled, false);
  assert.equal(work('alpha', 3).args.toolsEnabled, true);
  work('alpha', 3).complete();
  await until(() => work('alpha', 4));
  assert.equal(work('alpha', 4).args.toolsEnabled, false);
  runner.setAccess({toolsEnabled: false});
  assert.equal(runner.run.toolsEnabled, false);
  assert.equal(work('beta', 1).args.signal.aborted, false);
  clock.advance(4900);
  await runner.done;
  assert.equal(runner.run.status, 'complete');
  assert.equal(runner.run.endReason, 'deadline');
  assert.equal(runner.run.deadlineAt, before.deadlineAt);
});

test('real work defaults to standard tools, elections remain inspect-only and invalid settings do not mutate access', async (t) => {
  const {runner, calls, start, work} = fixture(t);
  start();
  await until(() => work('alpha', 1));
  assert.equal(runner.run.toolsEnabled, true);
  assert.equal(work('alpha', 1).args.toolsEnabled, true);
  assert(calls.filter(({args}) => args.phase === 'election').every(({args}) => args.toolsEnabled === false));
  for (const options of [{}, {toolsEnabled: 'yes'}, {toolsEnabled: 1}, {toolsEnabled: []}]) {
    assert.throws(() => runner.setAccess(options), /boolean/i);
    assert.equal(runner.run.toolsEnabled, true);
  }
  runner.stop();
  await runner.done;
  assert.throws(() => runner.setAccess({toolsEnabled: true}), (error) => error.statusCode === 409);
});

test('inspect-only and demo starts cannot accidentally acquire standard tool access', async (t) => {
  const {runner, start, work} = fixture(t);
  assert.throws(() => start({toolsEnabled: 'yes'}), /boolean/i);
  start({toolsEnabled: false});
  await until(() => work('alpha', 1));
  assert.equal(runner.run.toolsEnabled, false);
  runner.stop();
  await runner.done;
  start({demo: true, toolsEnabled: true});
  assert.equal(runner.run.toolsEnabled, false);
  assert.throws(() => runner.setAccess({toolsEnabled: true}), /simulation cannot use real tools/i);
});

test('access API updates only its explicit live chat and preserves the selected chat', async (t) => {
  const {runner, store, agents, cleanup} = fixture(t);
  const server = await startServer({runner, store, port: 0, capabilities: []});
  cleanup.push(() => server.close());
  const headers = {Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json'};
  const post = (path, body) => fetch(`${server.url}${path}`, {method: 'POST', headers, body: JSON.stringify(body)});
  const start = async (options) => {
    const response = await post('/api/run', {task: 'Independent access settings', agents, timeoutSeconds: 5, ...options});
    assert.equal(response.status, 201);
    return response.json();
  };
  const first = await start({toolsEnabled: false});
  const second = await start({toolsEnabled: false});
  const defaults = await (await fetch(`${server.url}/api/state`, {headers})).json();
  assert.equal(defaults.defaults.toolsEnabled, true);
  const denied = await fetch(`${server.url}/api/access`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({runId: first.id, toolsEnabled: true})});
  assert.equal(denied.status, 401);
  const response = await post('/api/access', {runId: first.id, toolsEnabled: true});
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.equal(changed.id, first.id);
  assert.equal(changed.toolsEnabled, true);
  assert.equal(server.conversations.run.id, second.id);
  assert.equal(server.conversations.run.toolsEnabled, false);
  assert.equal(server.conversations.getRunner(first.id).run.deadlineAt, first.deadlineAt);
  assert.equal((await post('/api/access', {runId: first.id, toolsEnabled: 'yes'})).status, 400);
  assert.equal(server.conversations.getRunner(first.id).run.toolsEnabled, true);
  assert.equal((await post('/api/access', {runId: 'missing-run', toolsEnabled: true})).status, 404);
  assert.equal((await post('/api/stop', {runId: first.id})).status, 200);
  assert.equal((await post('/api/access', {runId: first.id, toolsEnabled: true})).status, 409);
  const demo = await start({demo: true});
  assert.equal((await post('/api/access', {runId: demo.id, toolsEnabled: true})).status, 400);
});
