import {agentPresence, publicOutput} from './ui.js';

const CHAT_KINDS = new Set(['message', 'contribution', 'direction', 'election', 'proposal', 'vote', 'assignment', 'identity', 'membership', 'coordination', 'workstream', 'access']);
const timestamp = (value) => value == null ? Infinity : Number(new Date(value));

function initialDirection(message, run, firstDirection) {
  if (message.initial === true) return message.from === 'user' && message.kind === 'direction';
  if (message.initial === false || message !== firstDirection) return false;
  const text = message.text?.replace(/\n\[Truncated excerpt\]$/, '');
  const elapsed = timestamp(message.at) - timestamp(run.startedAt);
  return message.from === 'user' && message.kind === 'direction' && elapsed >= 0 && elapsed < 1000 && Boolean(text) && run.task?.startsWith(text);
}

// Messages are canonical. Events mirror them with different IDs, so legacy
// events are only used when a saved run has no message records at all.
export function groupChatEntries(run) {
  if (!run) return [];
  const source = run.messages?.length ? run.messages : (run.events || [])
    .filter((event) => ['message', 'handoff'].includes(event.type) && (event.agentId || event.role === 'user'))
    .map((event) => ({...event, from: event.agentId || 'user', to: event.toAgentId || 'all', kind: event.kind || (event.role === 'user' ? 'direction' : 'message')}));
  const firstDirection = source.filter((message) => message.from === 'user' && message.kind === 'direction').sort((a, b) => timestamp(a.at) - timestamp(b.at))[0];
  const messages = source.filter((message) => CHAT_KINDS.has(message.kind || 'message') && typeof message.text === 'string' && message.text.trim() && !initialDirection(message, run, firstDirection))
    .map((message, index) => ({...message, id: message.id || `${run.id}-message-${index}`, kind: message.kind || 'message'}));
  for (const agent of run.agents || []) {
    if (!agent.currentOutput) continue;
    if (agent.cycle != null && messages.some((message) => message.from === agent.id && message.kind === 'contribution' && message.cycle === agent.cycle)) continue;
    const text = publicOutput(agent.currentOutput);
    const live = agentPresence(agent, run).active && !/^Retrying:/i.test(agent.activity || '');
    if (!text.trim() && !live) continue;
    messages.push({
      id: `${run.id}-stream-${agent.id}-${agent.cycle ?? agent.cycles ?? 0}`,
      from: agent.id, to: 'all', kind: 'contribution', text,
      at: agent.currentOutputAt ?? agent.cycleStartedAt ?? null,
      cycle: agent.cycle, streaming: live, partial: !live, pending: !text.trim(),
      ...(agent.workstream?.id ? {workstreamId: agent.workstream.id} : {}),
    });
  }
  return messages.map((message, index) => ({message, index})).sort((a, b) => {
    const left = timestamp(a.message.at);
    const right = timestamp(b.message.at);
    return (Number.isNaN(left) ? Infinity : left) - (Number.isNaN(right) ? Infinity : right) || a.index - b.index;
  }).map(({message}) => message);
}
