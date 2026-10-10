import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {captureRunBaseline, finalizeRunChanges, getRunChanges} from '../src/workspace-changes.mjs';
import {RunStore} from '../src/store.mjs';
import {SwarmRunner} from '../src/runner.mjs';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'swarm-changes-'));
  const directory = join(workspace, 'custom-run-storage');
  await mkdir(directory);
  t.after(() => rm(workspace, {recursive: true, force: true}));
  return {workspace, directory, runId: randomUUID()};
}

test('changes compare against the actual run-start files including previously uncommitted content', async (t) => {
  const options = await fixture(t);
  const {workspace} = options;
  await writeFile(join(workspace, 'edit.txt'), 'Existing user change\nold line\n');
  await writeFile(join(workspace, 'delete.txt'), 'Remove this line\n');
  await captureRunBaseline(options);
  await writeFile(join(workspace, 'edit.txt'), 'Existing user change\nnew line\n');
  await writeFile(join(workspace, 'added.txt'), 'New artifact\n');
  await rm(join(workspace, 'delete.txt'));
  const report = await getRunChanges(options);
  assert.equal(report.available, true);
  assert.equal(report.frozen, false);
  assert.deepEqual(report.files.map(({path, status}) => ({path, status})), [
    {path: 'added.txt', status: 'added'}, {path: 'delete.txt', status: 'deleted'}, {path: 'edit.txt', status: 'modified'},
  ]);
  const modified = report.files.find(({path}) => path === 'edit.txt');
  assert.match(modified.diff, / Existing user change/);
  assert.match(modified.diff, /-old line\n\+new line/);
  assert.equal(modified.additions, 1);
  assert.equal(modified.deletions, 1);
  assert.match(report.description, /not attributed to individual agents/);
});

test('baselines exclude private files, binary data, heavy trees, symlinks and custom run storage', async (t) => {
  const options = await fixture(t);
  const {workspace, directory, runId} = options;
  for (const folder of ['node_modules', '.git', '.swarm', '.ssh', '.AWS', '.Codex']) await mkdir(join(workspace, folder));
  for (const path of ['.env', '.git/config', '.swarm/state', '.ssh/key', '.AWS/credentials', '.Codex/auth.json', 'node_modules/source.js', 'credentials.json']) await writeFile(join(workspace, path), 'PRIVATE_FIXTURE_CONTENT');
  await writeFile(join(directory, 'private-run.json'), 'PRIVATE_FIXTURE_CONTENT');
  await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(workspace, 'source.txt'), 'Original\n');
  await symlink('source.txt', join(workspace, 'shortcut'));
  await captureRunBaseline(options);
  const baseline = await readFile(join(directory, '.changes', runId, 'baseline.json'), 'utf8');
  assert(!baseline.includes('PRIVATE_FIXTURE_CONTENT'));
  assert.deepEqual(JSON.parse(baseline).files.map(({path}) => path), ['source.txt']);
  await writeFile(join(workspace, 'source.txt'), 'Revised\n');
  const report = await getRunChanges(options);
  assert.deepEqual(report.files.map(({path}) => path), ['source.txt']);
  assert.equal(report.skipped.binary, 1);
});

test('finished run reports freeze before later workspace edits', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.workspace, 'result.txt'), 'Before\n');
  await captureRunBaseline(options);
  await writeFile(join(options.workspace, 'result.txt'), 'Finished artifact\n');
  const finished = await finalizeRunChanges(options);
  assert.equal(finished.frozen, true);
  await writeFile(join(options.workspace, 'result.txt'), 'Unrelated later edit\n');
  await writeFile(join(options.workspace, 'later.txt'), 'Not part of the run\n');
  assert.deepEqual(await getRunChanges(options), finished);
  assert.deepEqual(await finalizeRunChanges(options), finished);
  assert.match(finished.files[0].diff, /\+Finished artifact/);
});

test('files omitted by size limits do not become false additions or deletions', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.workspace, 'oversized.txt'), 'x'.repeat(256 * 1024 + 1));
  await writeFile(join(options.workspace, 'kept.txt'), 'Small original\n');
  await captureRunBaseline(options);
  await writeFile(join(options.workspace, 'oversized.txt'), 'Now small\n');
  await writeFile(join(options.workspace, 'kept.txt'), 'y'.repeat(256 * 1024 + 1));
  const report = await getRunChanges(options);
  assert.equal(report.truncated, true);
  assert.deepEqual(report.files, []);
});

test('aggregate snapshot and report bounds never mislabel a still-existing baseline file as deleted', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.workspace, 'zz-existing.txt'), 'Unchanged\n');
  await captureRunBaseline(options);
  for (let index = 0; index < 17; index++) await writeFile(join(options.workspace, `a-${String(index).padStart(2, '0')}.txt`), 'Long line\n'.repeat(24000));
  const report = await getRunChanges(options);
  assert.equal(report.truncated, true);
  assert(!report.files.some(({path, status}) => path === 'zz-existing.txt' && status === 'deleted'));
  assert(report.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.diff), 0) <= 1024 * 1024);
});

test('legacy runs explicitly report an unavailable baseline and invalid IDs cannot escape storage', async (t) => {
  const options = await fixture(t);
  const report = await getRunChanges(options);
  assert.equal(report.available, false);
  assert.deepEqual(report.files, []);
  assert.match(report.reason, /no change baseline/);
  for (const runId of ['../../outside', '', null]) await assert.rejects(captureRunBaseline({...options, runId}), /Invalid run ID/);
});

test('an interrupted run without a final snapshot never presents later edits as its finished changes', async (t) => {
  const options = await fixture(t);
  await captureRunBaseline(options);
  await writeFile(join(options.workspace, 'later.txt'), 'Written after interruption\n');
  const report = await getRunChanges({...options, finished: true});
  assert.equal(report.available, false);
  assert.deepEqual(report.files, []);
  assert.match(report.reason, /No final change snapshot/);
});

test('runner captures before agent actions and freezes only after cancellation cleanup, excluding colocated run storage', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'swarm-changes-lifecycle-'));
  const store = new RunStore(workspace);
  const working = new Set();
  const runner = new SwarmRunner({store, workspace, adapter: async ({id, phase, signal}) => {
    if (phase === 'election') return {text: '{"candidateId":"peer-01"}'};
    working.add(id);
    try {await delay(10000, undefined, {signal});}
    finally {
      if (id === 'peer-01') {await delay(25); await writeFile(join(workspace, 'cleanup.txt'), 'Written during action cleanup\n');}
    }
    return {text: 'Unexpected completed work'};
  }});
  t.after(async () => {runner.stop(); await runner.done; await rm(workspace, {recursive: true, force: true});});
  runner.start({task: 'Capture real lifecycle changes', agentCount: 2, timeoutSeconds: 5});
  for (let attempt = 0; working.size < 2 && attempt < 300; attempt++) await delay(5);
  assert.equal(working.size, 2);
  runner.stop();
  await runner.done;
  const options = {workspace, directory: store.directory, runId: runner.run.id, finished: true};
  const report = await getRunChanges(options);
  assert.equal(report.frozen, true);
  assert.deepEqual(report.files.map(({path}) => path), ['cleanup.txt']);
  assert.match(report.files[0].diff, /\+Written during action cleanup/);
  await writeFile(join(workspace, 'cleanup.txt'), 'Unrelated later action\n');
  assert.deepEqual(await getRunChanges(options), report);
});
