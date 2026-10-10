import {setTimeout as delay} from 'node:timers/promises';
import {defaultTeam} from './team.mjs';

export const DEMO_TASK = 'Design a faster onboarding flow for a developer tool.';

export function demoTeam() {
  return defaultTeam().map((agent, index) => ({
    ...agent,
    harness: ['codex', 'claude', 'native', 'codex'][index],
    model: ['gpt-5-codex', 'sonnet', 'gateway-model', 'gpt-5-codex'][index],
  }));
}

const contributions = {
  scout: 'The first useful result should happen before configuration.\n\n1. Start with a working example.\n2. Ask for one task, then show a visible result.\n3. Move model and team settings into an optional control.\n\nSuccess metric: time from opening the tool to the first completed task. These are design recommendations, not measured improvements.',
  builder: 'Proposed flow\n\nOpen → try an example → watch the team → inspect the answer → bring your own task.\n\nKeep one primary action on each screen. Give every agent a visible state and make its conversation one click away. Save the task locally so a refresh preserves the work.\n\nDeliverable: a three-step onboarding outline. No application files were changed in this demo.',
  critic: 'Review\n\nThe flow removes early decisions, but it must distinguish example activity from live work. Label the replay clearly. Show failures where they happen. Never imply a finished animation means a finished task.\n\nKeep keyboard access and reduced-motion support. Validate the real flow with first-time users before claiming a conversion lift.',
  lead: 'A faster path to the first useful result\n\n1. Try a working example immediately.\n2. Show the team, its live progress, and every public contribution.\n3. Invite the user to run their own task with a model and harness of their choice.\n\nShip one input, one clear result, and a conversation you can inspect. Keep advanced settings one step away.\n\nNext: test with five first-time users and measure time to the first completed task.\n\nThis is a simulated demo. No model calls or file changes were made.',
};

export async function runDemoAgent({id, signal, onEvent}) {
  onEvent({type: 'status', text: 'Preparing contribution'});
  await delay(700, undefined, {signal});
  onEvent({type: 'tool', text: id === 'critic' ? 'Reviewing shared contributions · demo' : 'Inspecting task context · demo'});
  await delay(500, undefined, {signal});
  const text = contributions[id] || 'Demo contribution complete.';
  for (const part of text.match(/.{1,32}(?:\s|$)|\n/gs) || [text]) {
    signal.throwIfAborted();
    onEvent({type: 'delta', text: part});
    await delay(100, undefined, {signal});
  }
  return {text, usage: null};
}
