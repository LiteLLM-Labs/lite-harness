export const HARNESS_NAMES = { native: 'Swarm native', codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', opencode: 'OpenCode', pi: 'Pi' };
const MARKS = { native: 'swarm', codex: 'codex', 'claude-code': 'claude-code', claude: 'claude-code', opencode: 'opencode', pi: 'pi' };

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function logo(harness, className = '') {
  const image = element('img', className);
  image.src = `/assets/${MARKS[harness] || 'swarm'}.svg`;
  image.alt = '';
  image.width = 24;
  image.height = 24;
  return image;
}

export function modelLogo(model, harness) {
  const name = String(model || '').toLowerCase();
  const provider = /claude|anthropic|sonnet|opus|haiku/.test(name) ? 'anthropic' : /openai|gpt|(?:^|\/)o[134](?:-|$)/.test(name) ? 'openai' : !name && ['claude', 'claude-code'].includes(harness) ? 'anthropic' : !name && harness === 'codex' ? 'openai' : null;
  const image = element('img', 'model-logo');
  image.src = provider ? `/assets/model-${provider}.svg` : '/assets/swarm.svg';
  image.alt = provider ? `${provider === 'openai' ? 'OpenAI' : 'Anthropic'} model` : 'Model';
  image.title = model || 'Harness default model';
  return image;
}

export function identityLogos(agent) {
  const pair = element('span', 'identity-logos');
  pair.append(logo(agent?.harness || 'native'));
  if (agent) pair.append(modelLogo(agent.model, agent.harness));
  return pair;
}

export function shortModel(model, harness) {
  return model || `${HARNESS_NAMES[harness] || harness} default`;
}

export function elapsed(start, end = Date.now()) {
  if (!start) return '0s';
  const seconds = Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '0s';
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

// Model output is rendered as text, never interpreted as markup or executable HTML.
export function richText(container, text) {
  const parts = String(text || '').split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) container.append(element('code', '', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**')) container.append(element('strong', '', part.slice(2, -2)));
    else container.append(document.createTextNode(part));
  }
}

const COLLABORATION_KEYS = ['text', 'contribution', 'result', 'identity', 'workstream', 'messages', 'assignments', 'proposal', 'votes'];

function envelopeText(candidate, partial) {
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || !COLLABORATION_KEYS.some((key) => Object.hasOwn(parsed, key))) return null;
    for (const value of [parsed.text, parsed.contribution, parsed.result, parsed.proposal?.text]) if (typeof value === 'string' && value) return value;
    return Array.isArray(parsed.messages) ? parsed.messages.map((message) => typeof message?.text === 'string' ? message.text : '').filter(Boolean).join('\n\n') : '';
  } catch {
    if (!partial || !/^\{\s*"(?:text|contribution|result|identity|workstream|messages|assignments|proposal|votes)"\s*:/.test(candidate)) return null;
    const match = candidate.match(/"(?:text|contribution|result)"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/);
    if (!match) return '';
    let text = match[1];
    // Incomplete unicode escapes must wait for the next chunk.
    text = text.replace(/\\u[0-9a-f]{0,3}$/i, '');
    try { return JSON.parse(`"${text}"`); } catch { return ''; }
  }
}

// Unwrap only recognizable collaboration envelopes. Surrounding public prose
// and ordinary JSON/code examples remain text, never executable markup.
export function publicOutput(value) {
  const raw = String(value || '');
  let unwrapped = false;
  const prose = raw.replace(/```(?:json)?\s*([\s\S]*?)(```|$)/gi, (block, content, closing) => {
    const text = envelopeText(content.trim(), !closing);
    if (text === null) return block;
    unwrapped = true;
    return text;
  });
  if (unwrapped) return prose.trim();
  return envelopeText(raw.trimStart(), true) ?? raw;
}

export function publicTranscript(value) {
  return String(value || '').replace(/(^|\n\n)(Cycle \d+(?: — [^\n]*)?\n)([\s\S]*?)(?=\n\nCycle \d+(?: — [^\n]*)?\n|$)/g,
    (_, gap, heading, output) => `${gap}${heading}${publicOutput(output)}`);
}

export function currentWork(agent) {
  return publicOutput(agent.currentOutput) || publicOutput(agent.output) || publicOutput(agent.lastContribution);
}

export function agentPresence(agent, run) {
  const active = run?.status === 'running' && ['running', 'working'].includes(agent.status);
  return {active, label: active ? 'Active' : 'Inactive', leader: Boolean(run?.coordinatorId && agent.id === run.coordinatorId)};
}

export function stageDescription(agent) {
  if (agent.status === 'running' || agent.status === 'working') return agent.activity || 'Working';
  if (agent.status === 'complete') return 'Complete';
  if (agent.status === 'failed') return agent.activity || 'Failed';
  if (agent.status === 'stopped') return 'Stopped';
  return agent.activity || 'Ready to contribute';
}

export function consensusLabel(consensus) {
  if (!consensus || typeof consensus !== 'object') return '';
  const agree = Number(consensus.agree ?? 0);
  const eligible = Number(consensus.eligible ?? consensus.total ?? 0);
  const cast = Number(consensus.cast ?? 0);
  if (!eligible) return '';
  const status = ['accepted', 'agreed', 'consensus'].includes(consensus.status) ? 'Accepted' : consensus.status === 'rejected' ? 'Rejected' : 'Pending';
  return `${status}: ${agree}/${eligible} agree${cast ? ` · ${cast} cast` : ''}`;
}

export function replaceText(node, value) {
  const text = String(value || '');
  if (node.dataset.value === text) return;
  node.dataset.value = text;
  const position = node.scrollTop;
  node.replaceChildren();
  richText(node, text);
  node.scrollTop = position;
}
