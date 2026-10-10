const MAX_REPLY = 200000;
const boundedText = (value, limit = 8000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const objectValue = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Accept a fenced or embedded object without guessing JSON from individual lines.
// The scan tracks strings so braces inside a quoted public message stay intact.
export function readPublicObject(text) {
  if (typeof text !== 'string' || text.length > MAX_REPLY) return null;
  try { const value = JSON.parse(text.trim()); if (objectValue(value)) return value; } catch {}
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) { if (char === '{') {start = index; depth = 1;} continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { const value = JSON.parse(text.slice(start, index + 1)); if (objectValue(value)) return value; } catch {}
      start = -1;
    }
  }
  return null;
}

export function parseElectionReply(text, agentIds) {
  const object = readPublicObject(text);
  const vote = objectValue(object?.vote) ? object.vote : object;
  if (!agentIds.includes(vote?.candidateId)) return null;
  return {candidateId: vote.candidateId, reason: boundedText(vote.reason, 2000)};
}

function parseIdentity(value) {
  if (!objectValue(value)) return null;
  const identity = {};
  if (typeof value.name === 'string') {
    const name = value.name.trim();
    if (name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name)) identity.name = name;
  }
  if (typeof value.role === 'string') {
    const role = value.role.trim();
    if (role && role.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(role)) identity.role = role;
  }
  return Object.keys(identity).length ? identity : null;
}

export function parseIdentityReply(text) {
  return parseIdentity(readPublicObject(text)?.identity);
}

export function parseWorkReply(text, agentIds) {
  const object = readPublicObject(text);
  const structured = object && ['text', 'contribution', 'messages', 'assignments', 'proposal', 'votes', 'result', 'identity'].some((key) => Object.hasOwn(object, key));
  if (!structured) return {text: boundedText(text, MAX_REPLY), messages: [], assignments: [], votes: [], proposal: null, result: '', identity: null};
  const messages = (Array.isArray(object.messages) ? object.messages : []).slice(0, 12)
    .filter((message) => objectValue(message) && (message.to === 'all' || agentIds.includes(message.to)) && boundedText(message.text))
    .map((message) => ({to: message.to, text: boundedText(message.text)}));
  const assignments = (Array.isArray(object.assignments) ? object.assignments : []).slice(0, agentIds.length)
    .filter((assignment) => objectValue(assignment) && agentIds.includes(assignment.agentId) && boundedText(assignment.task))
    .map((assignment) => ({agentId: assignment.agentId, task: boundedText(assignment.task)}));
  const votes = (Array.isArray(object.votes) ? object.votes : []).slice(0, 20)
    .filter((vote) => objectValue(vote) && typeof vote.proposalId === 'string' && ['agree', 'disagree', 'abstain'].includes(vote.stance))
    .map((vote) => ({proposalId: vote.proposalId.slice(0, 120), stance: vote.stance, reason: boundedText(vote.reason, 2000)}));
  const proposal = objectValue(object.proposal) && boundedText(object.proposal.text)
    ? {id: boundedText(object.proposal.id, 80), text: boundedText(object.proposal.text)} : null;
  const result = boundedText(object.result, MAX_REPLY);
  const contribution = boundedText(object.text ?? object.contribution, MAX_REPLY) || result || proposal?.text || messages.map((message) => message.text).join('\n\n');
  return {text: contribution, messages, assignments, votes, proposal, result, identity: parseIdentity(object.identity), resultProposalId: boundedText(object.resultProposalId, 120)};
}

export function countConsensus(proposal, agentIds) {
  // Membership freezes when a proposal is created. Joining peers cannot change
  // its threshold or cast retroactive votes; older saved proposals use the roster.
  const electorate = proposal.electorate === undefined ? agentIds : proposal.electorate;
  const eligible = [...new Set((Array.isArray(electorate) ? electorate : [])
    .filter((id) => typeof id === 'string' && id.trim() && id === id.trim() && id !== proposal.from))];
  const votes = [...new Map(proposal.votes.filter((vote) => eligible.includes(vote.voterId) && ['agree', 'disagree', 'abstain'].includes(vote.stance)).map((vote) => [vote.voterId, vote])).values()];
  const count = (stance) => votes.filter((vote) => vote.stance === stance).length;
  const threshold = Math.floor(eligible.length / 2) + 1;
  const agree = count('agree');
  const disagree = count('disagree');
  return {
    agree, disagree, abstain: count('abstain'), cast: votes.length, eligible: eligible.length, threshold,
    status: agree >= threshold ? 'accepted' : disagree >= threshold ? 'rejected' : 'pending',
    unanimous: eligible.length > 0 && agree === eligible.length,
  };
}

export function chooseCoordinator(votes, candidateIds) {
  const sorted = [...candidateIds].sort();
  const tally = Object.fromEntries(sorted.map((id) => [id, votes.filter((vote) => vote.candidateId === id).length]));
  const maximum = Math.max(0, ...Object.values(tally));
  const tied = sorted.filter((id) => tally[id] === maximum);
  return {
    coordinatorId: tied[0] ?? null, tally,
    method: maximum === 0 ? 'no-votes-lexical-fallback' : tied.length > 1 ? 'plurality-lexical-tiebreak' : 'plurality',
  };
}
