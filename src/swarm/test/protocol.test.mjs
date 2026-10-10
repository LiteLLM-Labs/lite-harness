import test from 'node:test';
import assert from 'node:assert/strict';
import {countConsensus} from '../src/protocol.mjs';

const vote = (voterId, stance = 'agree') => ({voterId, stance});

test('proposal membership and majority stay frozen when peers join', () => {
  const proposal = {from: 'author', electorate: ['author', 'peer-01', 'peer-02'], votes: [vote('peer-01'), vote('peer-02')]};
  const initial = countConsensus(proposal, proposal.electorate);
  const expanded = countConsensus(proposal, [...proposal.electorate, ...Array.from({length: 97}, (_, index) => `joiner-${index}`)]);
  assert.deepEqual(expanded, initial);
  assert.deepEqual(expanded, {agree: 2, disagree: 0, abstain: 0, cast: 2, eligible: 2, threshold: 2, status: 'accepted', unanimous: true});
});

test('joining peers and the proposal author cannot supply a missing majority', () => {
  const proposal = {from: 'author', electorate: ['author', 'peer-01', 'peer-02'], votes: [vote('peer-01'), vote('author'), vote('joiner')]};
  const consensus = countConsensus(proposal, [...proposal.electorate, 'joiner']);
  assert.equal(consensus.agree, 1);
  assert.equal(consensus.cast, 1);
  assert.equal(consensus.status, 'pending');
  assert.equal(consensus.unanimous, false);
});

test('a later proposal includes new members without changing the older proposal', () => {
  const roster = ['author', 'peer-01', 'joiner'];
  const old = {from: 'author', electorate: roster.slice(0, 2), votes: [vote('peer-01')]};
  const recent = {...old, electorate: roster, votes: [vote('peer-01')]};
  assert.equal(countConsensus(old, roster).status, 'accepted');
  assert.equal(countConsensus(recent, roster).status, 'pending');
  assert.equal(countConsensus({...recent, votes: [...recent.votes, vote('joiner')]}, roster).status, 'accepted');
});

test('frozen votes keep dissent and abstentions and count only the latest vote per member', () => {
  const proposal = {
    from: 'author', electorate: ['author', 'peer-01', 'peer-02', 'peer-03'],
    votes: [vote('peer-01'), vote('peer-01', 'disagree'), vote('peer-02', 'disagree'), vote('peer-03', 'abstain'), vote('joiner')],
  };
  assert.deepEqual(countConsensus(proposal, [...proposal.electorate, 'joiner']), {
    agree: 0, disagree: 2, abstain: 1, cast: 3, eligible: 3, threshold: 2, status: 'rejected', unanimous: false,
  });
});

test('legacy proposals without an electorate continue using the supplied roster', () => {
  const proposal = {from: 'author', votes: [vote('peer-01'), vote('unknown')]};
  assert.deepEqual(countConsensus(proposal, ['author', 'peer-01']), {
    agree: 1, disagree: 0, abstain: 0, cast: 1, eligible: 1, threshold: 1, status: 'accepted', unanimous: true,
  });
});

test('invalid or empty frozen electorates never widen to the current roster', () => {
  for (const electorate of [null, {}, 'peer-01', [], ['author']]) {
    const consensus = countConsensus({from: 'author', electorate, votes: [vote('peer-01')]}, ['author', 'peer-01']);
    assert.equal(consensus.eligible, 0);
    assert.equal(consensus.threshold, 1);
    assert.equal(consensus.cast, 0);
    assert.equal(consensus.status, 'pending');
    assert.equal(consensus.unanimous, false);
  }
});

test('electorates discard invalid IDs and duplicates without mutating saved data', () => {
  const electorate = Object.freeze(['author', 'peer-01', 'peer-01', null, 12, '', ' ', ' peer-02']);
  const votes = Object.freeze([Object.freeze(vote('peer-01'))]);
  const proposal = Object.freeze({from: 'author', electorate, votes});
  const consensus = countConsensus(proposal, ['author', 'peer-01', 'joiner']);
  assert.equal(consensus.eligible, 1);
  assert.equal(consensus.cast, 1);
  assert.equal(consensus.status, 'accepted');
  assert.equal(electorate.length, 8);
});
