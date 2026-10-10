import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RunStore} from '../src/store.mjs';
import {SwarmRunner} from '../src/runner.mjs';
import {defaultTeam, validateTeam} from '../src/team.mjs';

function setup(t, adapter) {
  const path = mkdtempSync(join(tmpdir(), 'swarm-test-'));
  const store = new RunStore(path);
  const runner = new SwarmRunner({store, workspace: path, adapter});
  t.after(async () => {runner.stop(); await runner.done; rmSync(path, {recursive: true, force: true});});
  return {runner, store};
}

test('workers run in parallel; dependency contributions and steering reach later agents', async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((accept) => {release = accept;});
  const {runner, store} = setup(t, async ({id, prompt, onEvent}) => {
    calls.push({id, prompt});
    if (['scout', 'builder'].includes(id)) await gate;
    onEvent({type: 'delta', text: `${id} answer`});
    return {text: `${id} answer`, model: 'resolved-model'};
  });
  runner.start({task: 'Make something useful'});
  await delay(5);
  assert.deepEqual(calls.map((call) => call.id), ['scout', 'builder']);
  runner.steer('Keep the scope small.');
  release();
  await runner.done;
  assert.equal(runner.run.status, 'complete');
  assert.equal(runner.run.result, 'lead answer');
  assert.match(calls.find((call) => call.id === 'critic').prompt, /scout answer/);
  assert.match(calls.find((call) => call.id === 'critic').prompt, /builder answer/);
  assert.match(calls.find((call) => call.id === 'lead').prompt, /critic answer/);
  assert.match(calls.find((call) => call.id === 'critic').prompt, /Keep the scope small/);
  assert.equal(store.get(runner.run.id).agents[0].model, 'resolved-model');
});

test('failed workers block dependents and preserve successful contributions', async (t) => {
  const {runner} = setup(t, async ({id}) => {
    if (id === 'builder') throw new Error('Provider unavailable');
    return {text: 'Useful research'};
  });
  runner.start({task: 'Test failure'});
  await runner.done;
  assert.equal(runner.run.status, 'failed');
  assert.equal(runner.run.result, '');
  assert.equal(runner.run.agents[0].output, 'Useful research');
  assert.equal(runner.run.agents[2].activity, 'Blocked by a failed dependency');
});

test('stop aborts running adapters, prevents queued calls and rejects overlapping starts', async (t) => {
  const calls = [];
  const {runner} = setup(t, async ({id, signal}) => {
    calls.push(id);
    await delay(10000, undefined, {signal});
    return {text: 'should not finish'};
  });
  runner.start({task: 'Long task'});
  await delay(5);
  runner.stop();
  assert.throws(() => runner.start({task: 'race'}), /already running or stopping/);
  await runner.done;
  assert.equal(runner.run.status, 'stopped');
  assert.equal(runner.run.agents.every((agent) => agent.status === 'stopped'), true);
  assert.deepEqual(calls, ['scout', 'builder']);
});

test('follow-up includes previous result and recovery labels unfinished runs interrupted', async (t) => {
  const prompts = [];
  const {runner, store} = setup(t, async ({prompt}) => {prompts.push(prompt); return {text: 'Prior useful result'};});
  runner.start({task: 'First task'});
  await runner.done;
  const firstId = runner.run.id;
  runner.start({task: 'Refine it', parentId: firstId});
  await runner.done;
  assert.match(prompts[4], /Prior useful result/);
  store.save({...runner.run, status: 'running'});
  store.recover();
  assert.equal(store.get(runner.run.id).status, 'interrupted');
});

test('invalid dependency graphs and unbounded input are rejected before starting', (t) => {
  const {runner} = setup(t, async () => ({text: 'answer'}));
  const cyclic = defaultTeam(); cyclic[0].dependsOn = ['lead'];
  assert.throws(() => validateTeam(cyclic), /cycle/);
  const missing = defaultTeam(); missing[2].dependsOn = ['absent'];
  assert.throws(() => validateTeam(missing), /Unknown dependency/);
  assert.throws(() => runner.start({task: '', timeoutSeconds: 10}), /Enter a task/);
  assert.throws(() => runner.start({task: 'ok', timeoutSeconds: 0}), /Time limit/);
  assert.throws(() => runner.start({task: 'ok', toolsEnabled: 'true'}), /boolean/);
  assert.throws(() => runner.start({task: 'ok', demo: 'false'}), /boolean/);
  assert.equal(runner.run, null);
});

test('store lock rejects concurrent writers and invalid history IDs', (t) => {
  const {store} = setup(t, async () => ({text: 'ok'}));
  const release = store.acquire();
  assert.throws(() => new RunStore(store.directory).acquire(), /Another swarm/);
  assert.equal(store.get('../secrets'), null);
  release();
  store.acquire();
  store.release();
});

test('initial persistence failure rolls back the run so a retry can start', async (t) => {
  const {runner, store} = setup(t, async () => ({text: 'ok'}));
  const save = store.save.bind(store);
  store.save = () => {throw new Error('Disk full');};
  assert.throws(() => runner.start({task: 'Should not start'}), /Could not save/);
  assert.equal(runner.busy, false);
  assert.equal(runner.run, null);
  store.save = save;
  runner.start({task: 'Retry'});
  await runner.done;
  assert.equal(runner.run.status, 'complete');
});

test('a later persistence failure stops work and preserves unsaved output in memory', async (t) => {
  const {runner, store} = setup(t, async ({signal, onEvent}) => {
    onEvent({type: 'delta', text: 'Partial public progress'});
    await delay(10000, undefined, {signal});
    return {text: 'Should not finish'};
  });
  runner.start({task: 'Persistence failure'});
  await delay(5);
  store.save = () => {throw new Error('Disk full');};
  runner.flush();
  await runner.done;
  assert.equal(runner.run.status, 'failed');
  assert.equal(runner.busy, false);
  assert.equal(runner.run.agents[0].output, 'Partial public progress');
  assert.match(runner.run.events.at(-1).text, /Could not save progress/);
});

test('corrupt and wrong-shape history does not prevent recovery', (t) => {
  const {store} = setup(t, async () => ({text: 'ok'}));
  for (const value of ['null', '{"status":"running"}', 'broken json']) writeFileSync(join(store.directory, `${randomUUID()}.json`), value);
  assert.deepEqual(store.list(), []);
  assert.doesNotThrow(() => store.recover());
});

test('public progress before a final answer survives in the transcript and events', async (t) => {
  const {runner} = setup(t, async ({onEvent}) => {
    onEvent({type: 'delta', text: 'I inspected the project.\n\n'});
    onEvent({type: 'tool', text: 'read_file completed'});
    onEvent({type: 'delta', text: 'Final answer'});
    return {text: 'Final answer'};
  });
  runner.start({task: 'Inspect'});
  await runner.done;
  assert.match(runner.run.agents[0].transcript, /I inspected the project/);
  assert.equal(runner.run.agents[0].output, 'Final answer');
  assert.ok(runner.run.events.some((event) => event.phase === 'progress' && event.text === 'I inspected the project.'));
});
