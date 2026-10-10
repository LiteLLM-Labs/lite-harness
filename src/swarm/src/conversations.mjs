import {EventEmitter} from 'node:events';
import {SwarmRunner} from './runner.mjs';

function requestError(message, statusCode) {
  return Object.assign(new Error(message), {statusCode});
}

/** Independent chat lifecycles sharing one workspace, store and process lock. */
export class Conversations extends EventEmitter {
  constructor({runner, store, maxActive = 4}) {
    super();
    this.initialRunner = runner;
    this.store = store;
    this.maxActive = maxActive;
    this.records = new Map(store.list().reverse().map((run, order) => [run.id, {run, runner: null, order}]));
    this.sequence = this.records.size;
    this.listeners = new Map();
    this.selectedId = runner.run?.id ?? null;
    this.track(runner);
  }

  observe(runner) {
    if (!runner.run) return;
    const {id} = runner.run;
    for (const [previousId, record] of this.records) {
      if (record.runner === runner && previousId !== id) record.runner = null;
    }
    if (!this.records.has(id) || !this.selectedId) this.selectedId = id;
    this.records.set(id, {run: runner.run, runner, order: this.records.get(id)?.order ?? this.sequence++});
    this.emit('state');
  }

  track(runner) {
    const listeners = {
      state: () => this.observe(runner),
      event: (event) => this.emit('event', {...event, runId: runner.run?.id}, runner.run),
      delta: (event) => this.emit('delta', {...event, runId: runner.run?.id}, runner.run),
    };
    this.listeners.set(runner, listeners);
    for (const [type, listener] of Object.entries(listeners)) runner.on(type, listener);
    if (runner.run) this.observe(runner);
  }

  untrack(runner) {
    for (const [type, listener] of Object.entries(this.listeners.get(runner) || {})) runner.off(type, listener);
    this.listeners.delete(runner);
  }

  get run() {
    const record = this.records.get(this.selectedId);
    return record?.runner?.run ?? record?.run ?? null;
  }

  getRunner(id = this.selectedId) {return this.records.get(id)?.runner ?? null;}

  summaries() {
    const runs = [...this.records.values()].map(({run, runner, order}) => ({run: runner?.run ?? run, order}))
      .sort((a, b) => b.run.startedAt - a.run.startedAt || b.order - a.order).map(({run}) => run);
    const selected = runs.findIndex(({id}) => id === this.selectedId);
    if (selected > 0) runs.unshift(...runs.splice(selected, 1));
    return runs.map(({id, task, status, startedAt, demo}) => ({id, task, status, startedAt, demo}));
  }

  start(options) {
    if (this.closing) throw requestError('This workspace is shutting down.', 503);
    if ([...this.listeners.keys()].filter((runner) => runner.busy).length >= this.maxActive) {
      throw requestError(`Up to ${this.maxActive} chats can work at once. Stop one before starting another.`, 429);
    }
    const initial = this.initialRunner;
    const runner = !initial.run && !initial.busy ? initial : new SwarmRunner({store: this.store, workspace: initial.workspace, adapter: initial.adapter, clock: initial.clock});
    const fresh = runner !== initial;
    if (fresh) this.track(runner);
    try {
      const run = runner.start(options);
      this.selectedId = run.id;
      this.observe(runner);
      return run;
    } catch (error) {
      if (fresh) this.untrack(runner);
      throw error;
    }
  }

  target(id = this.selectedId) {
    if (typeof id !== 'string' || !id) throw requestError('Choose a chat first.', 400);
    let record = this.records.get(id);
    if (!record) {
      const run = this.store.get(id);
      if (!run) throw requestError('Chat not found.', 404);
      record = {run, runner: null, order: this.sequence++};
      this.records.set(id, record);
    }
    return record;
  }

  select(id) {
    if (typeof id !== 'string' || !id) throw requestError('Choose a chat first.', 400);
    const record = this.target(id);
    this.selectedId = id;
    this.emit('state');
    return record.runner?.run ?? record.run;
  }

  steer(text, id = this.selectedId) {
    const {runner} = this.target(id);
    if (!runner || runner.run.status !== 'running') throw requestError('This chat has finished. Start a new chat or continue it.', 409);
    return runner.steer(text);
  }

  addAgents(options, id = this.selectedId) {
    if (this.closing) throw requestError('This workspace is shutting down.', 503);
    const {runner} = this.target(id);
    if (!runner || runner.run.status !== 'running') throw requestError('Add agents to a running chat, or start a new one.', 409);
    return runner.addAgents(options);
  }

  async stop(id = this.selectedId) {
    const record = this.target(id);
    if (!record.runner) return record.run;
    record.runner.stop();
    await record.runner.done;
    this.observe(record.runner);
    return record.runner.run;
  }

  close() {
    if (!this.closing) this.closing = (async () => {
      const runners = [...this.listeners.keys()];
      for (const runner of runners) runner.stop('Workspace closed');
      await Promise.allSettled(runners.map((runner) => runner.done));
      for (const runner of runners) this.untrack(runner);
    })();
    return this.closing;
  }
}
