import {setTimeout as delay} from 'node:timers/promises';
import {defaultTeam} from './team.mjs';

export const DEMO_TASK = 'Design a faster onboarding flow for a developer tool.';
export function demoTeam() { return defaultTeam(); }

const FINDINGS = {
  'peer-01': ['Start with a working example before asking for configuration.', 'Separate the first useful result from optional setup. Measure time to first result.'],
  'peer-02': ['Proposed path: open → try an example → inspect the answer → bring your own task.', 'Give each screen one primary action. Persist the task so a refresh keeps the work.'],
  'peer-03': ['Compare a sample-first flow with a configuration-first flow using the same task.', 'Evaluate time to value, confusion, and whether users can explain the result.'],
  'peer-04': ['Label example activity as simulated. A finished animation must not imply verified work.', 'Keep provider failures visible beside the affected agent; preserve successful work.'],
  'peer-05': ['Verification plan: test fresh start, refresh, reconnect, stop, and saved output.', 'These are proposed checks. No real application was tested during this demo.'],
  'peer-06': ['Show each agent’s assignment, active work, and latest output in its card.', 'Keep the human answer separate from the raw activity feed. Make both easy to inspect.'],
  'peer-07': ['A default example can explain the product while the user explores the interface.', 'Use a small task that yields an understandable result in the first session.'],
  'peer-08': ['Combining the team’s recommendations into a three-step onboarding proposal.', 'The proposal now includes failure states, accessible controls, and an evaluation plan.'],
  'peer-09': ['A faster flow can still mislead people if it conceals model failures or simulated data.', 'Challenge any claimed conversion uplift until a real evaluation supports it.'],
  'peer-10': ['Explain the controls inline: enter a task, choose a work duration, inspect the answer.', 'The quick start should distinguish a simulated demo from a real model-backed run.'],
};

export async function runDemoAgent({id, signal, onEvent, phase, cycle = 1, team, coordinatorId, board}) {
  if (phase === 'election') {
    onEvent({type: 'status', text: 'Choosing a coordinator · simulated vote'});
    await delay(600, undefined, {signal});
    const identity = {name: `Peer ${id.slice(-2)}`, role: `I will ${FINDINGS[id]?.[0]?.charAt(0).toLowerCase()}${FINDINGS[id]?.[0]?.slice(1) || 'contribute to the task.'}`};
    return {text: JSON.stringify({identity, candidateId: team.find((peer) => peer.id === 'peer-08')?.id || team[0].id, reason: 'Integration fits this task; every peer continues its own work. Simulated vote.'})};
  }
  onEvent({type: 'status', text: cycle === 1 ? 'Inspecting the onboarding task · demo' : 'Reviewing new peer findings · demo'});
  await delay(900 + team.findIndex((peer) => peer.id === id) * 95, undefined, {signal});
  onEvent({type: 'tool', text: 'Comparing shared contributions · simulated activity'});
  const options = FINDINGS[id] || ['Share an independent recommendation and review peer findings.'];
  const text = `${options[(cycle - 1) % options.length]}\n\nDemo contribution ${cycle}. No model calls or file changes were made.`;
  for (const part of text.match(/.{1,34}(?:\s|$)|\n/gs) || [text]) {
    signal.throwIfAborted();
    onEvent({type: 'delta', text: part});
    await delay(110, undefined, {signal});
  }
  const coordinator = id === coordinatorId;
  const payload = {
    text,
    messages: [{to: coordinator ? 'all' : coordinatorId || 'all', text: options[(cycle - 1) % options.length]}],
    votes: (board?.proposals || []).slice(-1).map((proposal) => ({proposalId: proposal.id, stance: 'agree', reason: 'This recommendation accounts for my review concern. Simulated vote.'})),
  };
  if (coordinator && cycle === 1) {
    payload.proposal = {id: 'sample-first', text: 'Use a sample-first onboarding flow, show visible agent work, and label simulated activity.'};
    payload.assignments = team.filter((peer) => peer.id !== id).map((peer) => ({agentId: peer.id, task: `${peer.role} Review the sample-first proposal and report one remaining gap.`}));
  }
  if (coordinator) payload.result = `A faster path to the first useful result\n\n1. Try a working example immediately.\n2. Show each agent’s work and public contributions as they happen.\n3. Put the evolving answer beside the live feed.\n4. Invite the user to bring their own task, with advanced settings one step away.\n\n${cycle > 1 ? 'Peer review added clear failure states, keyboard access, and a plan to test with five first-time users.' : 'The team is reviewing this initial proposal.'}\n\nThis is a simulated demonstration, not an evaluated product change. Update ${cycle}.`;
  return {text: JSON.stringify(payload), usage: null};
}
