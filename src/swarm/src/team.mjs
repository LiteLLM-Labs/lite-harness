export const HARNESSES = ['native', 'codex', 'claude', 'opencode', 'pi'];
export const DEFAULT_AGENT_COUNT = 10;
export const MAX_AGENTS = 100;

export function validateAgentCount(value, {minimum = 2} = {}) {
  if (!Number.isInteger(value) || value < minimum || value > MAX_AGENTS) throw new Error(`Choose ${minimum}–${MAX_AGENTS} agents.`);
  return value;
}

// Explicit current choices; Claude's opus alias follows its installed CLI catalog.
export function defaultModel(harness, env = process.env) {
  if (harness === 'claude') return 'opus';
  if (harness === 'codex') return 'gpt-6.1-sol';
  return env.LITELLM_MODEL || 'openai/gpt-6-astra';
}

const DEFAULT_HARNESSES = ['claude', 'codex', 'opencode', 'claude', 'codex', 'pi', 'opencode', 'codex', 'claude', 'pi'];
const PEER_ROLE = 'You are an equal peer with no preassigned specialty. Choose a useful role from the task, tell the team what you will contribute, and adapt through collaboration.';

export function defaultTeam({count = DEFAULT_AGENT_COUNT, harness, model, existing = []} = {}) {
  validateAgentCount(count, {minimum: 1});
  if (!Array.isArray(existing) || existing.length + count > MAX_AGENTS) throw new Error(`A swarm supports at most ${MAX_AGENTS} agents.`);
  if (harness != null && !HARNESSES.includes(harness)) throw new Error(`Unknown harness: ${harness}`);
  const used = new Set(existing.map((peer) => typeof peer === 'string' ? peer : peer.id));
  let next = 1;
  return Array.from({length: count}, (_, index) => {
    while (used.has(`peer-${String(next).padStart(2, '0')}`)) next++;
    const preferredHarness = DEFAULT_HARNESSES[(existing.length + index) % DEFAULT_HARNESSES.length];
    const selected = harness || preferredHarness;
    const number = String(next++).padStart(2, '0');
    used.add(`peer-${number}`);
    return {id: `peer-${number}`, name: `Agent ${number}`, role: PEER_ROLE, harness: selected, model: model ?? defaultModel(selected)};
  });
}

export function validateTeam(input) {
  if (!Array.isArray(input)) throw new Error(`A swarm needs 2–${MAX_AGENTS} agents.`);
  validateAgentCount(input.length);
  const ids = new Set();
  return input.map((agent) => {
    if (!agent || typeof agent !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(agent.id)) throw new Error('Agent IDs must use lowercase letters, digits, and hyphens.');
    if (ids.has(agent.id)) throw new Error(`Duplicate agent ID: ${agent.id}`);
    ids.add(agent.id);
    if (!HARNESSES.includes(agent.harness)) throw new Error(`Unknown harness: ${agent.harness}`);
    if (typeof agent.name !== 'string' || !agent.name.trim() || agent.name.length > 60) throw new Error('Each agent needs a name (60 characters max).');
    if (typeof agent.role !== 'string' || !agent.role.trim() || agent.role.length > 2000) throw new Error('Each agent needs a role (2,000 characters max).');
    if (agent.model != null && (typeof agent.model !== 'string' || !agent.model.trim() || agent.model.length > 200)) throw new Error('Choose an explicit model name (200 characters max).');
    if (agent.dependsOn != null && (!Array.isArray(agent.dependsOn) || agent.dependsOn.length)) throw new Error('Swarm peers work concurrently. Remove dependsOn from this team configuration.');
    return {id: agent.id, name: agent.name.trim(), role: agent.role.trim(), harness: agent.harness, model: agent.model ?? defaultModel(agent.harness)};
  });
}

export function validateTask(task) {
  if (typeof task !== 'string' || !task.trim() || task.length > 16000) throw new Error('Enter a task between 1 and 16,000 characters.');
  return task.trim();
}
