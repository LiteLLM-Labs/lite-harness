// Membership is declared by peers. Historical messages keep their original
// workstream stamp even if their author later changes focus.
export const UNGROUPED = '__ungrouped';

export function workstreamsForRun(run) {
  const streams = new Map();
  for (const stream of [...(run?.workstreams || []), ...(run?.agents || []).map((agent) => agent.workstream)]) {
    if (stream?.id && !streams.has(stream.id)) streams.set(stream.id, {id: stream.id, name: stream.name || stream.id});
  }
  return [...streams.values()];
}

export function workstreamMembers(run, selected = '') {
  return (run?.agents || []).filter((agent) => !selected || (selected === UNGROUPED ? !agent.workstream?.id : agent.workstream?.id === selected));
}

export function inWorkstream(message, selected = '') {
  if (!selected || message.from === 'user' || message.agentId === 'user' || message.role === 'user') return true;
  return selected === UNGROUPED ? !message.workstreamId : message.workstreamId === selected;
}
