import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTeam, defaultModel, validateTeam, validateAgentCount, DEFAULT_AGENT_COUNT, MAX_AGENTS} from '../src/team.mjs';

test('default organization has ten concurrent peers across all four CLI harnesses', () => {
  const team = defaultTeam();
  assert.equal(team.length, 10);
  assert.deepEqual(team.map((peer) => peer.name), Array.from({length: 10}, (_, index) => `Agent ${String(index + 1).padStart(2, '0')}`));
  assert.equal(new Set(team.map((peer) => peer.role)).size, 1);
  assert.match(team[0].role, /no preassigned specialty/);
  assert.deepEqual([...new Set(team.map((peer) => peer.harness))].sort(), ['claude', 'codex', 'opencode', 'pi']);
  assert.equal(team.some((peer) => peer.id === 'lead' || peer.dependsOn?.length), false);
  assert.deepEqual(validateTeam(team), team);
  assert.equal(defaultTeam({harness: 'native', model: 'my-deployment'}).every((peer) => peer.harness === 'native' && peer.model === 'my-deployment'), true);
});

test('model choices are explicit and gateway overrides do not change separate CLI models', () => {
  const env = {LITELLM_MODEL: 'my-private-alias'};
  assert.equal(defaultModel('codex', env), 'gpt-6.1-sol');
  assert.equal(defaultModel('claude', env), 'opus');
  for (const harness of ['native', 'opencode', 'pi']) {
    assert.equal(defaultModel(harness, env), 'my-private-alias');
    assert.equal(defaultModel(harness, {}), 'openai/gpt-6-astra');
  }
});

test('legacy serialized pipelines and invalid peers are rejected before inference', () => {
  const team = defaultTeam();
  assert.throws(() => validateTeam(team.map((peer, index) => index ? peer : {...peer, dependsOn: ['builder']})), /concurrently/);
  assert.throws(() => validateTeam([...team, team[0]]), /Duplicate/);
  assert.throws(() => validateTeam(team.map((peer) => ({...peer, model: ''}))), /explicit model/);
  assert.throws(() => validateTeam(team.map((peer) => ({...peer, harness: 'pretend'}))), /Unknown harness/);
  assert.throws(() => validateTeam([team[0]]), /2–100/);
});

test('team sizes are configurable up to 100 and added neutral peers have unique IDs', () => {
  assert.equal(DEFAULT_AGENT_COUNT, 10);
  assert.equal(MAX_AGENTS, 100);
  for (const count of [2, 24, 100]) {
    const team = validateTeam(defaultTeam({count}));
    assert.equal(team.length, count);
    assert.equal(new Set(team.map(({id}) => id)).size, count);
    assert.equal(new Set(team.map(({role}) => role)).size, 1);
  }
  const initial = defaultTeam({count: 24});
  const added = defaultTeam({count: 3, existing: initial, harness: 'pi', model: 'gateway-alias'});
  assert.deepEqual(added.map(({id}) => id), ['peer-25', 'peer-26', 'peer-27']);
  assert(added.every(({harness, model}) => harness === 'pi' && model === 'gateway-alias'));
  assert.equal(validateTeam([...initial, ...added]).length, 27);
  for (const count of [0, 1, 101, 2.5, '20', NaN]) assert.throws(() => validateAgentCount(count), /2–100/);
  assert.equal(validateAgentCount(1, {minimum: 1}), 1);
  assert.throws(() => defaultTeam({count: 2, existing: defaultTeam({count: 99})}), /at most 100/);
});
