import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/swarm.mjs', import.meta.url));

test('CLI generates a larger team and runs a count-configured simulation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-cli-count-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  await exec(process.execPath, [cli, 'init', '--agents', '25'], {cwd: directory});
  const configured = JSON.parse(readFileSync(join(directory, 'swarm.json'), 'utf8'));
  assert.equal(configured.agents.length, 25);
  assert.equal(new Set(configured.agents.map(({id}) => id)).size, 25);
  await assert.rejects(exec(process.execPath, [cli, 'run', 'Invalid count', '--agents', '101'], {cwd: directory}), (error) => {
    assert.match(error.stderr, /100/);
    return true;
  });
  const data = join(directory, 'runs');
  await exec(process.execPath, [cli, 'demo', '--agents', '25', '--duration', '5', '--data-dir', data, '--json'], {cwd: directory, timeout: 15000, maxBuffer: 8 * 1024 * 1024});
  const files = readdirSync(data).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(readFileSync(join(data, files[0]), 'utf8'));
  assert.equal(run.demo, true);
  assert.equal(run.status, 'complete');
  assert.equal(run.agents.length, 25);
  assert(run.agents.some(({cycles}) => cycles > 0));
  assert.equal(run.deadlineAt - run.startedAt, 5000);
});
