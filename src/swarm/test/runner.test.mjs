import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RunStore} from '../src/store.mjs';
import {SwarmRunner} from '../src/runner.mjs';
import {defaultTeam} from '../src/team.mjs';
import {parseWorkReply, parseElectionReply, parseIdentityReply, chooseCoordinator, countConsensus} from '../src/protocol.mjs';

function fakeClock() {
  let time = 1000000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) {const id = ++sequence; timers.set(id, {callback, at: time + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = target;
    },
  };
}
const deferred = () => {let resolve; const promise = new Promise((accept) => {resolve = accept;}); return {promise, resolve};};
async function until(check) {for (let attempt = 0; attempt < 300; attempt++) {if (check()) return; await delay(2);} assert.fail('Expected runtime condition did not occur');}
const ballot = (candidateId = 'peer-02') => ({text: JSON.stringify({candidateId, reason: 'Public coordination suitability'})});
const usefulAdapter = async ({phase, id, cycle, signal}) => {
  if (phase === 'election') return ballot();
  await delay(2, undefined, {signal});
  return {text: `${id} verified contribution ${cycle}`, model: 'resolved-model'};
};
function setup(t, adapter = usefulAdapter) {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-test-'));
  const store = new RunStore(directory);
  const clock = fakeClock();
  const runner = new SwarmRunner({store, workspace: directory, adapter, clock});
  t.after(async () => {runner.stop(); await runner.done; rmSync(directory, {recursive: true, force: true});});
  return {runner, store, clock};
}

test('ten independent ballots overlap, then all ten peers work concurrently and elect by explicit plurality', async (t) => {
  const electionGate = deferred();
  const workGate = deferred();
  const calls = [];
  const {runner, clock} = setup(t, async ({id, phase, signal}) => {
    calls.push({id, phase});
    if (phase === 'election') {await electionGate.promise; return ballot(['peer-01', 'peer-02', 'peer-03', 'peer-04', 'peer-05', 'peer-06'].includes(id) ? 'peer-05' : 'peer-02');}
    await Promise.race([workGate.promise, delay(10000, undefined, {signal})]);
    return {text: `${id} actual contribution`};
  });
  runner.start({task: 'Produce useful work', timeoutSeconds: 5});
  await until(() => calls.length === 10);
  assert.equal(runner.run.phase, 'electing');
  assert.equal(new Set(calls.map(({id}) => id)).size, 10);
  electionGate.resolve();
  await until(() => calls.filter(({phase}) => phase === 'work').length === 10);
  assert.equal(runner.run.coordinatorId, 'peer-05');
  assert.equal(runner.run.election.tally['peer-05'], 6);
  assert.equal(runner.run.election.method, 'plurality');
  workGate.resolve();
  await until(() => runner.run.agents.every(({cycles}) => cycles >= 1));
  clock.advance(5000);
  await runner.done;
  assert.equal(runner.run.status, 'complete');
});

test('finished cycles continue productive calls until the requested deadline and retain evolving coordinator results', async (t) => {
  const {runner, store, clock} = setup(t);
  runner.start({task: 'Keep investigating', timeoutSeconds: 5});
  await until(() => runner.run.agents.every(({cycles}) => cycles >= 2));
  assert.equal(runner.run.status, 'running');
  assert.ok(runner.run.results.length >= 2);
  assert.ok(runner.run.results.every((result) => result.agentId === 'peer-02' && result.provisional));
  const cycles = runner.agent('peer-01').cycles;
  clock.advance(4999);
  await until(() => runner.agent('peer-01').cycles > cycles);
  assert.equal(runner.run.status, 'running');
  clock.advance(1);
  await runner.done;
  assert.equal(runner.run.status, 'complete');
  assert.equal(runner.run.endReason, 'deadline');
  assert.equal(runner.run.endedAt, runner.run.deadlineAt);
  assert.match(runner.run.result, /peer-02 verified contribution/);
  assert.equal(store.get(runner.run.id).agents[0].model, 'resolved-model');
});

test('steering, peer messages, assignments and every peer latest contribution reach subsequent cycles', async (t) => {
  const calls = [];
  const {runner, clock} = setup(t, async (args) => {
    if (args.phase === 'election') return ballot();
    calls.push(args);
    await delay(2, undefined, {signal: args.signal});
    if (args.id === 'peer-02' && args.cycle === 1) return {text: JSON.stringify({text: 'I found the relevant module', messages: [{to: 'peer-01', text: 'Inspect the parser edge case'}], assignments: [{agentId: 'peer-01', task: 'Verify empty parser input'}], result: 'First concrete finding'})};
    return {text: `${args.id} contribution ${args.cycle}`};
  });
  runner.start({task: 'Inspect this project', timeoutSeconds: 5});
  await until(() => runner.agent('peer-02').cycles >= 1);
  runner.steer('Focus on accessibility.');
  await until(() => calls.some(({id, prompt}) => id === 'peer-01' && prompt.includes('Focus on accessibility.') && prompt.includes('Verify empty parser input')));
  const later = calls.find(({id, prompt}) => id === 'peer-01' && prompt.includes('Focus on accessibility.'));
  assert.match(later.prompt, /Inspect the parser edge case/);
  assert.equal(later.board.contributions.length, 10);
  assert.ok(runner.run.messages.some((message) => message.from === 'peer-02' && message.to === 'peer-01' && message.kind === 'assignment'));
  clock.advance(5000);
  await runner.done;
});

test('bounded election records abstentions instead of invented votes and leaves time for work', async (t) => {
  const {runner, clock} = setup(t, async ({phase, id, signal}) => {
    if (phase === 'election') {await delay(10000, undefined, {signal}); return ballot();}
    await delay(2, undefined, {signal});
    return {text: `${id} real work despite unavailable ballots`};
  });
  runner.start({task: 'Work after bounded election', timeoutSeconds: 5});
  await delay(5);
  clock.advance(750);
  await until(() => runner.run.phase === 'working');
  assert.equal(runner.run.election.votes.length, 0);
  assert.equal(runner.run.election.abstentions.length, 10);
  assert.equal(runner.run.election.method, 'no-votes-lexical-fallback');
  assert.equal(runner.run.coordinatorId, 'peer-01');
  await until(() => runner.run.agents.every(({cycles}) => cycles > 0));
  clock.advance(4250);
  await runner.done;
  assert.match(runner.run.result, /peer-01 real work/);
});

test('repeated peer failures preserve partial output, replace a failed coordinator transparently and do not stop surviving peers', async (t) => {
  const {runner, clock} = setup(t, async ({phase, id, onEvent, signal}) => {
    if (phase === 'election') return ballot();
    if (id === 'peer-02') {onEvent({type: 'delta', text: 'Found a useful clue before failure'}); throw new Error('Provider unavailable');}
    await delay(2, undefined, {signal});
    return {text: `${id} independent evidence`};
  });
  runner.start({task: 'Survive partial failure', timeoutSeconds: 5});
  await until(() => runner.agent('peer-02').failures === 1);
  clock.advance(1000);
  await until(() => runner.agent('peer-02').failures === 2);
  clock.advance(2000);
  await until(() => runner.agent('peer-02').status === 'failed');
  assert.match(runner.agent('peer-02').transcript, /useful clue/);
  assert.equal(runner.run.status, 'running');
  assert.equal(runner.run.coordinatorId, 'peer-01');
  assert.match(runner.run.coordinatorChanges[0].method, /prior-ballots/);
  await until(() => runner.run.results.some(({agentId}) => agentId === 'peer-01'));
  clock.advance(2000);
  await runner.done;
  assert.equal(runner.run.status, 'complete');
  assert.equal(runner.agent('peer-02').status, 'failed');
  assert.match(runner.run.result, /independent evidence/);
});

test('all peers blocked fail honestly without running fake work until the deadline', async (t) => {
  const {runner, clock} = setup(t, async ({phase}) => {if (phase === 'election') return ballot(); throw new Error('Authentication unavailable');});
  runner.start({task: 'Unavailable providers', timeoutSeconds: 5});
  await until(() => runner.run.agents.every(({failures}) => failures === 1));
  clock.advance(1000);
  await until(() => runner.run.agents.every(({failures}) => failures === 2));
  clock.advance(2000);
  await runner.done;
  assert.equal(runner.run.status, 'failed');
  assert.equal(runner.run.endReason, 'all-peers-failed');
  assert.equal(runner.run.results.length, 0);
  assert.ok(runner.run.agents.every(({cycles}) => cycles === 0));
});

test('stop waits for adapter cleanup, rejects overlapping starts and fences late callbacks', async (t) => {
  const cleanup = deferred();
  const callbacks = [];
  const {runner} = setup(t, async ({phase, signal, onEvent}) => {
    if (phase === 'election') return ballot();
    callbacks.push(onEvent);
    onEvent({type: 'delta', text: 'Partial public work'});
    await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
    await cleanup.promise;
    throw new Error('Process cleaned up');
  });
  runner.start({task: 'Cancellation', timeoutSeconds: 5});
  await until(() => callbacks.length === 10);
  runner.stop();
  assert.throws(() => runner.start({task: 'Race'}), /already running or stopping/);
  await delay(10);
  assert.equal(runner.busy, true);
  cleanup.resolve();
  await runner.done;
  const before = runner.run.agents.map(({output}) => output);
  callbacks.forEach((callback) => callback({type: 'delta', text: 'LATE OUTPUT'}));
  assert.deepEqual(runner.run.agents.map(({output}) => output), before);
  assert.equal(runner.run.status, 'stopped');
  assert.match(runner.run.result, /Partial public work/);
  assert.match(runner.agent('peer-01').transcript, /Partial public work/);
});

test('proposal consensus counts independent explicit votes once, excluding author and fabricated sender identities', async (t) => {
  const agreeIds = ['peer-01', 'peer-03', 'peer-04', 'peer-05', 'peer-06'];
  const {runner, clock} = setup(t, async ({phase, id, board, signal}) => {
    if (phase === 'election') return ballot();
    await delay(2, undefined, {signal});
    const proposal = board.proposals[0];
    return {text: JSON.stringify({
      text: `${id} public review`,
      ...(id === 'peer-02' ? {proposal: {id: 'plan', text: 'Concrete reviewed proposal'}, result: 'Provisional plan; see separately counted votes', consensus: {unanimous: true}} : {}),
      votes: proposal ? [{proposalId: proposal.id, voterId: 'someone-else', stance: agreeIds.includes(id) || id === 'peer-02' ? 'agree' : 'abstain', reason: 'Independent public review'}] : [],
    })};
  });
  runner.start({task: 'Review a real proposal', timeoutSeconds: 5});
  await until(() => runner.run.proposals[0]?.votes.length === 9);
  const proposal = runner.run.proposals[0];
  assert.equal(proposal.votes.some(({voterId}) => voterId === 'peer-02' || voterId === 'someone-else'), false);
  assert.equal(proposal.consensus.agree, 5);
  assert.equal(proposal.consensus.abstain, 4);
  assert.equal(proposal.consensus.status, 'accepted');
  assert.equal(proposal.consensus.unanimous, false);
  assert.equal(proposal.consensus.eligible, 9);
  assert.equal(runner.run.results[0].consensus, undefined);
  await until(() => runner.agent('peer-01').cycles >= 4);
  assert.equal(runner.run.proposals[0].votes.length, 9);
  clock.advance(5000);
  await runner.done;
});

test('plain text and fenced envelopes preserve public contributions while malformed ballots never become votes', () => {
  assert.equal(parseWorkReply('Useful plain answer', ['a', 'b']).text, 'Useful plain answer');
  assert.equal(parseElectionReply('I think a might be good', ['a', 'b']), null);
  const reply = parseWorkReply('Public note\n```json\n{"text":"A {quoted} finding","messages":[{"to":"b","text":"Please verify"},{"to":"outsider","text":"Reject"}]}\n```', ['a', 'b']);
  assert.equal(reply.text, 'A {quoted} finding');
  assert.deepEqual(reply.messages, [{to: 'b', text: 'Please verify'}]);
  assert.equal(chooseCoordinator([{candidateId: 'b'}, {candidateId: 'a'}], ['b', 'a']).coordinatorId, 'a');
  assert.equal(chooseCoordinator([], ['b', 'a']).method, 'no-votes-lexical-fallback');
  const summary = countConsensus({from: 'a', votes: [{voterId: 'b', stance: 'agree'}, {voterId: 'b', stance: 'agree'}, {voterId: 'a', stance: 'agree'}]}, ['a', 'b', 'c']);
  assert.equal(summary.cast, 1);
  assert.equal(summary.unanimous, false);
});

test('follow-up includes prior result and recovery marks unfinished work interrupted', async (t) => {
  const prompts = [];
  const {runner, store, clock} = setup(t, async (args) => {prompts.push(args.prompt); return usefulAdapter(args);});
  runner.start({task: 'First task', timeoutSeconds: 5});
  await until(() => runner.run.results.length > 0);
  clock.advance(5000); await runner.done;
  const firstId = runner.run.id;
  runner.start({task: 'Refine it', parentId: firstId, timeoutSeconds: 5});
  await until(() => runner.run.results.length > 0);
  assert.ok(prompts.some((prompt) => /Previous result:[\s\S]*peer-02 verified contribution/.test(prompt)));
  clock.advance(5000); await runner.done;
  store.save({...runner.run, status: 'running'}); store.recover();
  assert.equal(store.get(runner.run.id).status, 'interrupted');
});

test('persistence failures roll back initial start and abort later work without losing in-memory partials', async (t) => {
  const {runner, store} = setup(t, async ({phase, signal, onEvent}) => {
    if (phase === 'election') return ballot();
    onEvent({type: 'delta', text: 'Partial public progress'});
    await delay(10000, undefined, {signal});
    return {text: 'Should not finish'};
  });
  const save = store.save.bind(store);
  store.save = () => {throw new Error('Disk full');};
  assert.throws(() => runner.start({task: 'Fail to save'}), /Could not save/);
  assert.equal(runner.busy, false); assert.equal(runner.run, null);
  store.save = save;
  runner.start({task: 'Save then fail', timeoutSeconds: 5});
  await until(() => runner.agent('peer-01').output === 'Partial public progress');
  store.save = () => {throw new Error('Disk full');};
  runner.flush(); await runner.done;
  assert.equal(runner.run.status, 'failed');
  assert.equal(runner.busy, false);
  assert.equal(runner.agent('peer-01').output, 'Partial public progress');
  assert.match(runner.run.events.at(-1).text, /Could not save progress/);
});

test('public progress preceding the answer survives repeated cycles', async (t) => {
  const {runner, clock} = setup(t, async ({phase, signal, onEvent}) => {
    if (phase === 'election') return ballot();
    await delay(2, undefined, {signal});
    onEvent({type: 'delta', text: 'I inspected the project.\n\nFinal answer'});
    return {text: 'Final answer'};
  });
  runner.start({task: 'Inspect', timeoutSeconds: 5});
  await until(() => runner.agent('peer-01').cycles >= 2);
  clock.advance(5000); await runner.done;
  assert.match(runner.agent('peer-01').transcript, /I inspected the project/);
  assert.ok(runner.run.events.some(({phase, text}) => phase === 'progress' && text === 'I inspected the project.'));
});

test('streamed public text repeated in a final envelope is retained once per cycle', async (t) => {
  const {runner} = setup(t, async ({phase, signal, onEvent}) => {
    if (phase === 'election') return ballot();
    await delay(2, undefined, {signal});
    onEvent({type: 'delta', text: 'Verified evidence from the actual contribution.'});
    return {text: JSON.stringify({text: 'Verified evidence from the actual contribution.'})};
  });
  runner.start({task: 'Preserve public text without duplicates', timeoutSeconds: 5});
  await until(() => runner.agent('peer-01').cycles >= 2);
  runner.stop(); await runner.done;
  const agent = runner.agent('peer-01');
  assert.equal(agent.transcript.split('Verified evidence from the actual contribution.').length - 1, agent.cycles);
  assert.equal(runner.run.events.some(({phase}) => phase === 'progress'), false);
});

test('each election identity belongs to its actual peer even when the ballot is invalid', async (t) => {
  const {runner} = setup(t, async ({phase, id, signal}) => {
    if (phase === 'election') return {text: JSON.stringify({
      identity: {name: `Chosen ${id}`, role: `Investigate ${id} task evidence`, id: 'peer-10', agentId: 'peer-10', harness: 'native', model: 'forged-model'},
      candidateId: id === 'peer-01' ? 'invented-peer' : 'peer-02', reason: 'Explicit ballot',
    })};
    await delay(10000, undefined, {signal});
    return {text: 'Useful work'};
  });
  const initial = runner.start({task: 'Choose useful identities independently', timeoutSeconds: 5});
  await until(() => runner.run.phase === 'working');
  assert.equal(runner.run.election.votes.length, 9);
  assert.equal(runner.run.election.abstentions[0].voterId, 'peer-01');
  for (const peer of runner.run.agents) {
    const original = initial.agents.find(({id}) => id === peer.id);
    assert.equal(peer.name, `Chosen ${peer.id}`);
    assert.equal(peer.role, `Investigate ${peer.id} task evidence`);
    assert.equal(peer.assignment, peer.role);
    assert.equal(peer.assignmentSource, 'self');
    assert.equal(peer.harness, original.harness);
    assert.equal(peer.model, original.model);
  }
  assert.equal(runner.run.messages.filter(({kind}) => kind === 'identity').length, 10);
  assert.equal(runner.board().identities.length, 10);
  assert.doesNotMatch(runner.prompt(runner.agent('peer-01'), null), /Role hint:/);
});

test('work identities can revise only their own role and preserve explicit coordinator assignments', async (t) => {
  const {runner} = setup(t, async ({phase, signal}) => {
    if (phase === 'election') return ballot();
    await delay(10000, undefined, {signal});
    return {text: 'Useful work'};
  });
  runner.start({task: 'Self-organize responsibilities', timeoutSeconds: 5});
  await until(() => runner.run.phase === 'working');
  runner.acceptContribution('peer-01', 1, {text: JSON.stringify({identity: {name: 'Pathfinder', role: 'Inspect edge cases', agentId: 'peer-10'}})});
  assert.equal(runner.agent('peer-01').name, 'Pathfinder');
  assert.equal(runner.agent('peer-01').assignment, 'Inspect edge cases');
  assert.equal(runner.agent('peer-01').assignmentSource, 'self');
  assert.equal(runner.agent('peer-10').name, 'Agent 10');
  runner.acceptContribution('peer-02', 1, {text: JSON.stringify({text: 'Coordinate evidence', assignments: [{agentId: 'peer-01', task: 'Verify the empty input case'}]})});
  runner.acceptContribution('peer-01', 2, {text: JSON.stringify({identity: {name: 'Verifier', role: 'Verify independently'}})});
  assert.equal(runner.agent('peer-01').name, 'Verifier');
  assert.equal(runner.agent('peer-01').role, 'Verify independently');
  assert.equal(runner.agent('peer-01').assignment, 'Verify the empty input case');
  assert.equal(runner.agent('peer-01').assignmentSource, 'coordinator');
  const announcements = runner.run.messages.filter(({kind}) => kind === 'identity').length;
  runner.acceptContribution('peer-01', 3, {text: JSON.stringify({text: 'More useful evidence', identity: {name: 'Verifier', role: 'Verify independently'}})});
  assert.equal(runner.run.messages.filter(({kind}) => kind === 'identity').length, announcements);
});

test('malformed identities cannot change immutable metadata or create oversized public names and roles', () => {
  const parse = (identity) => parseIdentityReply(JSON.stringify({identity}));
  for (const identity of [null, [], 'other', {}, {name: ' '}, {name: 42, role: {}}, {name: 'x'.repeat(61), role: 'x'.repeat(2001)}, {name: 'bad\u001bname', role: 'bad\u0000role'}]) assert.equal(parse(identity), null);
  assert.deepEqual(parse({name: '  Chosen  ', role: '  First line\nSecond line  ', id: 'other', harness: 'other', model: 'other'}), {name: 'Chosen', role: 'First line\nSecond line'});
  assert.deepEqual(parse({name: 'x'.repeat(61), role: 'A valid responsibility'}), {role: 'A valid responsibility'});
  assert.equal(parseElectionReply(JSON.stringify({identity: {name: 'Chosen'}, candidateId: 'missing'}), ['peer-01']), null);
  assert.deepEqual(parseWorkReply(JSON.stringify({identity: {name: 'Chosen', role: 'Useful work'}}), ['peer-01']).identity, {name: 'Chosen', role: 'Useful work'});
});

test('input bounds and store recovery remain intact', (t) => {
  const {runner, store} = setup(t);
  assert.equal(defaultTeam().length, 10);
  assert.throws(() => runner.start({task: '', timeoutSeconds: 10}), /Enter a task/);
  assert.throws(() => runner.start({task: 'ok', timeoutSeconds: 0}), /Time limit/);
  assert.throws(() => runner.start({task: 'ok', toolsEnabled: 'true'}), /boolean/);
  assert.throws(() => runner.start({task: 'ok', demo: 'false'}), /boolean/);
  assert.equal(runner.run, null);
  const release = store.acquire();
  assert.throws(() => new RunStore(store.directory).acquire(), /Another swarm/);
  assert.equal(store.get('../secrets'), null); release();
  for (const value of ['null', '{"status":"running"}', 'broken json']) writeFileSync(join(store.directory, `${randomUUID()}.json`), value);
  assert.deepEqual(store.list(), []); assert.doesNotThrow(() => store.recover());
});


test('large shared histories stay bounded while every peer has a contribution slot and latest output stays full', (t) => {
  const {runner} = setup(t);
  runner.start({task: 'A'.repeat(16000), timeoutSeconds: 5});
  const full = 'Verified public evidence. '.repeat(7000);
  for (const agent of runner.run.agents) runner.updateAgent(agent.id, {lastContribution: full, output: full});
  for (let index = 0; index < 45; index++) runner.message('peer-01', 'all', full, 'contribution');
  runner.update({directions: Array.from({length: 100}, () => 'Keep the useful constraint. '.repeat(290))});
  const board = runner.board();
  assert.equal(board.contributions.length, 10);
  assert.ok(board.contributions.every(({text}) => text.length <= 2000));
  assert.ok(runner.run.messages.every(({text}) => text.length <= 8000));
  assert.ok(runner.run.events.every(({text}) => !text || text.length <= 8000));
  assert.equal(runner.agent('peer-01').output, full);
  assert.ok(runner.prompt(runner.agent('peer-01'), null, board).length <= 150000);
});

test('a timed-out work call cannot start its next cycle before cancellation cleanup settles', async (t) => {
  const cleanup = deferred();
  const calls = new Map();
  const {runner, clock} = setup(t, async ({phase, id, signal}) => {
    if (phase === 'election') return ballot();
    calls.set(id, (calls.get(id) || 0) + 1);
    if (calls.get(id) === 1) {
      await new Promise((accept) => signal.addEventListener('abort', accept, {once: true}));
      await cleanup.promise;
      throw new Error('Cancelled process has exited');
    }
    await delay(10000, undefined, {signal});
    return {text: 'Second work cycle'};
  });
  runner.start({task: 'Process cleanup ordering', timeoutSeconds: 300});
  await until(() => calls.size === 10);
  clock.advance(120000);
  await delay(15);
  assert.ok([...calls.values()].every((count) => count === 1));
  assert.ok(runner.run.agents.every(({failures}) => failures === 0));
  cleanup.resolve();
  await until(() => runner.run.agents.every(({failures}) => failures === 1));
  clock.advance(1000);
  await until(() => [...calls.values()].every((count) => count === 2));
  assert.equal(runner.run.status, 'running');
});

test('a broken adapter that never acknowledges abort cannot hold shutdown indefinitely', async (t) => {
  const {runner} = setup(t, async ({phase}) => phase === 'election' ? ballot() : new Promise(() => {}));
  runner.start({task: 'Bound broken adapter cleanup', timeoutSeconds: 5});
  await until(() => runner.run.phase === 'working');
  await delay(2);
  const started = Date.now();
  runner.stop();
  await runner.done;
  assert.ok(Date.now() - started >= 1900);
  assert.ok(Date.now() - started < 3500);
  assert.equal(runner.busy, false);
  assert.equal(runner.run.status, 'stopped');
});
