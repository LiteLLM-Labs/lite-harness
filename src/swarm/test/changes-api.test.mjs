import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunStore} from '../src/store.mjs';
import {SwarmRunner} from '../src/runner.mjs';
import {startServer} from '../src/server.mjs';
import {captureRunBaseline, finalizeRunChanges} from '../src/workspace-changes.mjs';

test('changes API authenticates, serves frozen historical diffs and preserves chat selection', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'swarm-changes-http-'));
  const store = new RunStore(join(workspace, '.swarm', 'runs'));
  const base = {task: 'Historical work', workspace, status: 'complete', startedAt: Date.now(), agents: [], events: [], directions: []};
  const selected = {...base, id: randomUUID()};
  const historical = {...base, id: randomUUID()};
  store.save(selected); store.save(historical);
  const options = {workspace, directory: store.directory, runId: historical.id};
  await captureRunBaseline(options);
  await writeFile(join(workspace, 'artifact.txt'), 'Verified artifact\n');
  await finalizeRunChanges(options);
  await writeFile(join(workspace, 'artifact.txt'), 'Later unrelated edit\n');
  const runner = new SwarmRunner({store, workspace});
  runner.run = selected;
  const server = await startServer({runner, store, port: 0, capabilities: []});
  t.after(async () => {await server.close(); await rm(workspace, {recursive: true, force: true});});
  const path = `/api/changes?runId=${historical.id}`;
  assert.equal((await fetch(server.url + path)).status, 401);
  const headers = {Authorization: `Bearer ${server.token}`};
  const response = await fetch(server.url + path, {headers});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.runId, historical.id);
  assert.equal(report.frozen, true);
  assert.match(report.files[0].diff, /\+Verified artifact/);
  assert(!JSON.stringify(report).includes('Later unrelated edit'));
  assert.equal(server.conversations.run.id, selected.id);
  assert.equal((await fetch(`${server.url}/api/changes?runId=missing`, {headers})).status, 404);
  const legacy = await (await fetch(`${server.url}/api/changes`, {headers})).json();
  assert.equal(legacy.available, false);
  for (const [extra, reason, pending] of [
    [{demo: true}, /simulated demo/, false],
    [{status: 'running', changes: {status: 'preparing'}}, /Preparing/, true],
    [{changes: {status: 'failed', reason: 'Storage unavailable'}}, /Storage unavailable/, false],
    [{changes: {status: 'unavailable', reason: 'No capture was requested'}}, /No capture was requested/, false],
  ]) {
    const run = {...base, id: randomUUID(), ...extra};
    store.save(run);
    const unavailable = await (await fetch(`${server.url}/api/changes?runId=${run.id}`, {headers})).json();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.pending, pending);
    assert.match(unavailable.reason, reason);
  }
});
