import test from 'node:test';
import assert from 'node:assert/strict';
import {groupChatEntries} from '../web/assets/chat-feed.js';

const peer = (id, changes = {}) => ({id, name: id, harness: 'native', model: 'test-model', status: 'complete', cycle: 1, cycles: 1, currentOutput: '', output: '', lastContribution: '', ...changes});
const run = (changes = {}) => ({id: 'chat-one', task: 'Original human task', startedAt: 1000, status: 'complete', agents: [peer('alpha'), peer('beta')], messages: [], events: [], ...changes});
const message = (id, changes = {}) => ({id, at: 2000, from: 'alpha', to: 'all', text: 'An actual public contribution.', kind: 'contribution', cycle: 1, ...changes});

test('canonical conversation does not duplicate mirrored events or include tool and status noise', () => {
  const entry = message('canonical');
  const entries = groupChatEntries(run({messages: [entry], events: [
    {...entry, id: 'different-event-id', agentId: 'alpha', toAgentId: 'all', type: 'message'},
    {id: 'tool', at: 2100, agentId: 'alpha', type: 'tool', text: 'read_file completed'},
    {id: 'status', at: 2200, agentId: 'beta', type: 'status', text: 'Cycle 2 started'},
    {id: 'result', at: 2300, agentId: 'alpha', type: 'result', text: 'Human result belongs in Result'},
  ]}));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, entry.text);
  assert.equal(entries[0].from, 'alpha');
});

test('user guidance and agent messages retain chronological order, recipients and proposal identity', () => {
  const entries = groupChatEntries(run({messages: [
    message('late', {at: 4000, kind: 'proposal', proposalId: 'alpha:plan'}),
    message('task', {at: 1000, from: 'user', text: 'Original human task', kind: 'direction'}),
    message('directed', {at: 2000, from: 'beta', to: 'alpha', text: 'Please verify the result.', kind: 'message'}),
    message('guidance', {at: 3000, from: 'user', text: 'Focus on accessibility.', kind: 'direction'}),
    message('tie', {at: 4000, from: 'beta', kind: 'vote', proposalId: 'alpha:plan', text: 'agree: independently verified'}),
  ]}));
  assert.deepEqual(entries.map(({id}) => id), ['directed', 'guidance', 'late', 'tie']);
  assert.equal(entries[0].from, 'beta');
  assert.equal(entries[0].to, 'alpha');
  assert.equal(entries[1].from, 'user');
  assert.equal(entries[2].proposalId, 'alpha:plan');
  assert.equal(entries[3].kind, 'vote');
});

test('identical text from different peers or work cycles remains separate authored messages', () => {
  const entries = groupChatEntries(run({messages: [
    message('alpha-first'), message('beta-first', {from: 'beta'}), message('alpha-next', {at: 3000, cycle: 2}),
  ]}));
  assert.deepEqual(entries.map(({id}) => id), ['alpha-first', 'beta-first', 'alpha-next']);
});

test('old event-only runs retain plain authored messages and directed handoffs', () => {
  const literal = '<script>plain reference text</script> {unfinished prose';
  const entries = groupChatEntries(run({messages: undefined, events: [
    {id: 'plain', at: 2000, agentId: 'alpha', type: 'message', text: literal},
    {id: 'handoff', at: 3000, agentId: 'beta', toAgentId: 'alpha', type: 'handoff', text: 'Check this finding.'},
    {id: 'status', at: 3500, agentId: 'alpha', type: 'status', text: 'Working'},
    {id: 'tool', at: 4000, agentId: 'alpha', type: 'tool', text: 'Command completed'},
  ]}));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, literal);
  assert.equal(entries[0].from, 'alpha');
  assert.equal(entries[1].from, 'beta');
  assert.equal(entries[1].to, 'alpha');
});

test('incremental JSON exposes decoded public text while stale previous output is never a new message', () => {
  const entries = groupChatEntries(run({status: 'running', agents: [
    peer('alpha', {status: 'running', cycle: 2, currentOutputAt: 5000, currentOutput: '{"identity":{"name":"Chosen"},"text":"Hello\\nteam', output: 'OLD COMPLETED ANSWER'}),
    peer('beta', {status: 'running', cycle: 2, currentOutputAt: 5000, currentOutput: '{"identity":{"name":"Preparing', output: 'ANOTHER OLD ANSWER'}),
  ]}));
  const alpha = entries.find(({from, streaming}) => from === 'alpha' && streaming);
  assert(alpha);
  assert.equal(alpha.text, 'Hello\nteam');
  assert.equal(alpha.to, 'all');
  assert.equal(entries.some(({text}) => text?.includes('OLD')), false);
  assert.equal(entries.some(({text}) => text?.includes('"identity"')), false);
  assert(entries.some(({from, pending, text}) => from === 'beta' && pending && !text));
});

test('terminal runs preserve readable partial work without claiming peers are streaming or typing', () => {
  for (const status of ['complete', 'stopped', 'failed', 'interrupted']) {
    const entries = groupChatEntries(run({status, agents: [peer('alpha', {status: 'running', cycle: 2, currentOutput: 'Actual unfinished work.'})]}));
    assert.equal(entries.some(({streaming, pending}) => streaming || pending), false, status);
    const partial = entries.find(({partial}) => partial);
    assert(partial, status);
    assert.equal(partial.text, 'Actual unfinished work.');
  }
});

test('retry backoff never presents preserved failed-attempt output as a live stream', () => {
  const entries = groupChatEntries(run({status: 'running', agents: [peer('alpha', {
    status: 'running', cycle: 2, activity: 'Retrying: upstream disconnected (1/3)', consecutiveFailures: 1, currentOutput: 'Partial from failed attempt.',
  })]}));
  assert.equal(entries.some(({streaming, pending}) => streaming || pending), false);
});

test('a completed contribution replaces its same-cycle transient stream', () => {
  const entries = groupChatEntries(run({status: 'running', messages: [message('accepted')], agents: [
    peer('alpha', {status: 'running', currentOutput: 'An actual public contribution.'}),
  ]}));
  assert.equal(entries.filter(({from, text}) => from === 'alpha' && text === 'An actual public contribution.').length, 1);
});

test('the earliest retained guidance stays visible after the initial task leaves message history', () => {
  const entries = groupChatEntries(run({messages: [message('retained-guidance', {at: 30000, from: 'user', kind: 'direction', text: 'Keep the keyboard flow simple.'})]}));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'retained-guidance');
});

test('a clipped long initial task does not duplicate the permanent human task bubble', () => {
  const task = 'A long user task. '.repeat(700);
  const suffix = '\n[Truncated excerpt]';
  const initial = message('initial', {at: 1000, from: 'user', kind: 'direction', text: task.slice(0, 8000 - suffix.length) + suffix});
  const entries = groupChatEntries(run({task, messages: [initial, message('answer')]}));
  assert.deepEqual(entries.map(({id}) => id), ['answer']);
});

test('explicit initial markers preserve immediate user guidance even when it repeats the original task', () => {
  const entries = groupChatEntries(run({messages: [
    message('initial', {at: 1000, from: 'user', kind: 'direction', text: 'Original human task', initial: true}),
    message('prefix-guidance', {at: 1050, from: 'user', kind: 'direction', text: 'Original human', initial: false}),
    message('repeated-guidance', {at: 1100, from: 'user', kind: 'direction', text: 'Original human task', initial: false}),
  ]}));
  assert.deepEqual(entries.map(({id}) => id), ['prefix-guidance', 'repeated-guidance']);
});

test('live public output uses its actual first-output time among stored messages', () => {
  const entries = groupChatEntries(run({status: 'running', agents: [peer('alpha', {
    status: 'running', cycle: 2, currentOutput: 'An update in progress.', currentOutputAt: 2500, cycleStartedAt: 1500,
  })], messages: [
    message('before', {from: 'beta', at: 2000}), message('after', {from: 'beta', at: 3000, cycle: 2}),
  ]}));
  assert.deepEqual(entries.map(({at}) => at), [2000, 2500, 3000]);
  assert.equal(entries[1].streaming, true);
});

test('one hundred agents add at most one current-output entry each without multiplying stored messages', () => {
  const agents = Array.from({length: 100}, (_, index) => peer(`peer-${index + 1}`, {status: 'running', cycle: 6, cycles: 5, currentOutputAt: 9000, currentOutput: `Real next work ${index}`}));
  const messages = Array.from({length: 500}, (_, index) => message(`saved-${index}`, {from: agents[index % 100].id, at: 2000 + index, cycle: Math.floor(index / 100) + 1}));
  const events = messages.map((entry) => ({...entry, id: `echo-${entry.id}`, agentId: entry.from, type: 'message'}));
  const entries = groupChatEntries(run({status: 'running', agents, messages, events}));
  assert.equal(entries.length, 600);
  assert.equal(entries.filter(({streaming}) => streaming).length, 100);
  assert.equal(new Set(entries.map(({id}) => id)).size, 600);
});
