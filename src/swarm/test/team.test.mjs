import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTeam, defaultModel, validateTeam} from '../src/team.mjs';

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
  assert.throws(() => validateTeam([team[0]]), /2–12/);
});
