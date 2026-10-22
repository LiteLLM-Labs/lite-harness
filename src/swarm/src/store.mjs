import {mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export class RunStore {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, {recursive: true, mode: 0o700});
  }

  acquire() {
    const path = join(this.directory, '.lock');
    try {
      mkdirSync(path, {mode: 0o700});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(readFileSync(join(path, 'pid'), 'utf8')); } catch {}
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probeError) { alive = probeError.code !== 'ESRCH'; }
      }
      if (alive) throw new Error(`Another swarm is using ${this.directory}. Use a different --data-dir or stop it first.`);
      rmSync(path, {recursive: true});
      mkdirSync(path, {mode: 0o700});
    }
    writeFileSync(join(path, 'pid'), String(process.pid), {mode: 0o600});
    this.lockPath = path;
    return () => this.release();
  }

  release() {
    if (!this.lockPath) return;
    try {
      if (readFileSync(join(this.lockPath, 'pid'), 'utf8') === String(process.pid)) rmSync(this.lockPath, {recursive: true});
    } finally { this.lockPath = null; }
  }

  save(run) {
    const destination = join(this.directory, `${run.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(run), {mode: 0o600});
    renameSync(temporary, destination);
  }

  get(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const path = join(this.directory, `${id}.json`);
    if (!existsSync(path)) return null;
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    if (!record || record.id !== id || typeof record.task !== 'string' || !Number.isFinite(record.startedAt) || !Array.isArray(record.agents) || !Array.isArray(record.events) || !Array.isArray(record.directions)) return null;
    if (!['running', 'complete', 'failed', 'stopped', 'interrupted'].includes(record.status)) return null;
    if (record.agents.some((agent) => !agent || typeof agent.id !== 'string' || typeof agent.output !== 'string')) return null;
    return record;
  }

  list() {
    return readdirSync(this.directory).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).flatMap((name) => {
      try { const run = this.get(name.slice(0, -5)); return run ? [run] : []; } catch { return []; }
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  recover() {
    for (const run of this.list()) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.endedAt = Date.now();
      for (const agent of run.agents) {
        if (['queued', 'running'].includes(agent.status)) {
          agent.status = 'stopped';
          agent.activity = 'Interrupted when the runner exited';
        }
      }
      this.save(run);
    }
  }
}
