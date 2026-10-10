import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {defaultTeam, validateTeam, validateTask} from './team.mjs';
import {demoTeam, DEMO_TASK, runDemoAgent} from './demo.mjs';
import {runAgent} from './adapters.mjs';

const MAX_OUTPUT = 200000;
const MAX_EVENTS = 600;

export class SwarmRunner extends EventEmitter {
  constructor({store, workspace = process.cwd(), adapter = runAgent}) {
    super();
    this.store = store;
    this.workspace = resolve(workspace);
    this.adapter = adapter;
    this.run = null;
    this.done = Promise.resolve();
  }

  start(options = {}) {
    if (this.busy) throw new Error('A swarm is already running or stopping. Wait before starting another.');
    if (options.demo != null && typeof options.demo !== 'boolean') throw new Error('demo must be a boolean.');
    const task = validateTask(options.demo ? DEMO_TASK : options.task);
    const team = validateTeam(options.demo ? demoTeam() : options.agents ?? defaultTeam(options));
    const timeoutSeconds = options.timeoutSeconds ?? 600;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 86400) throw new Error('Time limit must be 5–86,400 seconds.');
    if (options.toolsEnabled != null && typeof options.toolsEnabled !== 'boolean') throw new Error('toolsEnabled must be a boolean.');
    const previous = options.parentId ? this.store.get(options.parentId) : null;
    if (options.parentId && !previous) throw new Error('Previous run was not found.');
    const previousRun = this.run;
    this.persistenceError = null;
    this.busy = true;
    this.controller = new AbortController();
    this.run = {
      id: randomUUID(), task, status: 'running', startedAt: Date.now(), endedAt: null,
      workspace: this.workspace, demo: Boolean(options.demo), timeoutSeconds,
      toolsEnabled: Boolean(options.toolsEnabled), result: '', events: [], directions: [],
      parentId: previous?.id ?? null,
      agents: team.map((agent) => ({...agent, status: 'queued', output: '', activity: 'Waiting for dependencies', startedAt: null, endedAt: null, usage: null})),
    };
    this.event({type: 'message', agentId: 'user', text: task});
    try { this.flush(true); } catch (error) {
      this.controller.abort(error);
      this.busy = false;
      this.run = previousRun;
      throw new Error(`Could not save this run: ${error.message}`);
    }
    const timer = setTimeout(() => this.stop('Time limit reached'), timeoutSeconds * 1000);
    this.done = this.execute(previous).catch((error) => {
      this.run.status = 'failed';
      this.event({type: 'status', text: error.message});
    }).finally(() => {
      clearTimeout(timer);
      this.busy = false;
      this.run.endedAt = Date.now();
      this.flush();
    });
    return this.run;
  }

  event(event) {
    const entry = {id: randomUUID(), at: Date.now(), ...event};
    this.run.events.push(entry);
    if (this.run.events.length > MAX_EVENTS) this.run.events.shift();
    this.emit('event', entry);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 100);
  }

  flush(initial = false) {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.run) return;
    try {
      if (!this.persistenceError) this.store.save(this.run);
    } catch (error) {
      if (initial) throw error;
      this.persistenceError = error;
      this.run.status = 'failed';
      this.controller.abort(error);
      for (const agent of this.run.agents) {
        if (['running', 'queued'].includes(agent.status)) {agent.status = 'stopped'; agent.activity = 'Stopped because saving the run failed';}
      }
      const event = {id: randomUUID(), at: Date.now(), type: 'status', text: `Could not save progress: ${error.message}. Work stopped; this view retains unsaved output.`};
      this.run.events.push(event);
      this.emit('event', event);
    }
    this.emit('state', this.run);
  }

  steer(text) {
    if (this.run?.status !== 'running') throw new Error('Start a swarm to send a direction.');
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('A direction must be 1–8,000 characters.');
    if (!this.run.agents.some((agent) => agent.status === 'queued')) throw new Error('Every agent has started. Use a follow-up run for this direction.');
    if (this.run.directions.length >= 20) throw new Error('This run already has 20 directions.');
    this.run.directions.push(text.trim());
    this.event({type: 'message', agentId: 'user', text: text.trim()});
    this.event({type: 'status', text: 'Direction saved for agents that have not started yet.'});
    this.flush();
    return this.run;
  }

  stop(reason = 'Stopped by you') {
    if (this.run?.status !== 'running') return this.run;
    this.run.status = 'stopped';
    this.controller.abort(new Error(reason));
    for (const agent of this.run.agents) {
      if (['queued', 'running'].includes(agent.status)) {
        agent.status = 'stopped'; agent.activity = reason; agent.endedAt = Date.now();
      }
    }
    this.event({type: 'status', text: reason});
    this.flush();
    return this.run;
  }

  prompt(agent, previous) {
    const contributions = agent.dependsOn.map((id) => this.run.agents.find((item) => item.id === id));
    return [
      `You are ${agent.name}, part of a coordinated swarm. Your role: ${agent.role}`,
      `User task:\n${this.run.task}`,
      `Workspace: ${this.workspace}. File writes are ${this.run.toolsEnabled ? 'enabled; only implement files relevant to your assigned role' : 'disabled; read context and provide an answer'}.`,
      'Work on your assigned role. Give a concise useful contribution. Report observable actions and verified results, not hidden reasoning. Do not claim tools or changes you did not perform. Do not message external people or publish anything.',
      previous ? `Previous task:\n${previous.task}\nPrevious result:\n${previous.result.slice(0, 40000)}` : '',
      ...contributions.map((item) => `Contribution from ${item.name}:\n${item.output.slice(0, 40000)}`),
      ...this.run.directions.map((text) => `Additional user direction:\n${text}`),
    ].filter(Boolean).join('\n\n');
  }

  async execute(previous) {
    const pending = new Map();
    const executeOne = (agent) => {
      if (pending.has(agent.id)) return pending.get(agent.id);
      const promise = (async () => {
        await Promise.all(agent.dependsOn.map((id) => executeOne(this.run.agents.find((item) => item.id === id))));
        if (this.controller.signal.aborted) return;
        if (agent.dependsOn.some((id) => this.run.agents.find((item) => item.id === id).status !== 'complete')) {
          agent.status = 'failed'; agent.activity = 'Blocked by a failed dependency'; agent.endedAt = Date.now();
          this.event({type: 'status', agentId: agent.id, text: agent.activity});
          return;
        }
        await this.executeAgent(agent, previous);
      })();
      pending.set(agent.id, promise);
      return promise;
    };
    await Promise.all(this.run.agents.map(executeOne));
    if (this.controller.signal.aborted) return;
    this.run.status = this.run.agents.every((agent) => agent.status === 'complete') ? 'complete' : 'failed';
    const finalAgent = this.run.agents.find((agent) => !this.run.agents.some((other) => other.dependsOn.includes(agent.id)));
    if (finalAgent.status === 'complete') this.run.result = finalAgent.output;
    this.event({type: 'status', text: this.run.status === 'complete' ? 'Swarm complete. Your result is ready.' : 'Swarm failed. Completed contributions are preserved.'});
  }

  async executeAgent(agent, previous) {
    agent.status = 'running'; agent.startedAt = Date.now(); agent.activity = 'Starting';
    for (const id of agent.dependsOn) this.event({type: 'handoff', agentId: id, toAgentId: agent.id, text: `Contribution shared with ${agent.name}`});
    this.event({type: 'status', agentId: agent.id, text: `${agent.name} started`});
    try {
      const adapter = this.run.demo ? runDemoAgent : this.adapter;
      const result = await adapter({
        id: agent.id, harness: agent.harness, model: agent.model, prompt: this.prompt(agent, previous),
        cwd: this.workspace, toolsEnabled: this.run.toolsEnabled, signal: this.controller.signal,
        timeoutMs: this.run.timeoutSeconds * 1000,
        onEvent: (event) => {
          if (this.controller.signal.aborted) return;
          if (event.type === 'delta') {
            if (agent.output.length + String(event.text ?? '').length > MAX_OUTPUT) throw new Error('Agent output limit reached.');
            agent.output += String(event.text ?? '');
            agent.activity = 'Writing';
            this.emit('delta', {agentId: agent.id, text: event.text});
            this.scheduleFlush();
          } else {
            agent.activity = String(event.text || event.type).slice(0, 2000);
            this.event({type: event.type === 'tool' ? 'tool' : 'status', agentId: agent.id, text: agent.activity});
          }
        },
      });
      if (this.controller.signal.aborted) return;
      if (!result.text?.trim()) throw new Error('Agent returned no public answer.');
      if (result.text.length > MAX_OUTPUT) throw new Error('Agent output limit reached.');
      const streamed = agent.output.trim();
      const finalText = result.text.trim();
      agent.transcript = streamed || finalText;
      const progress = streamed.endsWith(finalText) ? streamed.slice(0, -finalText.length).trim() : streamed !== finalText ? streamed : '';
      if (progress) this.event({type: 'message', agentId: agent.id, phase: 'progress', text: progress});
      agent.output = result.text;
      agent.model = result.model || agent.model;
      agent.usage = result.usage ?? null;
      agent.status = 'complete'; agent.activity = 'Complete';
      this.event({type: 'message', agentId: agent.id, text: agent.output});
    } catch (error) {
      if (this.controller.signal.aborted) return;
      agent.status = 'failed'; agent.activity = String(error.message || error).slice(0, 2000);
      this.event({type: 'status', agentId: agent.id, text: agent.activity});
    } finally {
      agent.endedAt = Date.now(); this.flush();
    }
  }
}
