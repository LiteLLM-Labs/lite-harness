export const HARNESSES = ['native', 'codex', 'claude', 'opencode', 'pi'];

// Explicit current choices; Claude's opus alias follows its installed CLI catalog.
export function defaultModel(harness, env = process.env) {
  if (harness === 'claude') return 'opus';
  if (harness === 'codex') return 'gpt-6.1-sol';
  return env.LITELLM_MODEL || 'openai/gpt-6-astra';
}

const DEFAULT_HARNESSES = ['claude', 'codex', 'opencode', 'claude', 'codex', 'pi', 'opencode', 'codex', 'claude', 'pi'];
const PEER_ROLE = 'You are an equal peer with no preassigned specialty. Choose a useful role from the task, tell the team what you will contribute, and adapt through collaboration.';

export function defaultTeam({harness, model} = {}) {
  return DEFAULT_HARNESSES.map((preferredHarness, index) => {
    const selected = harness || preferredHarness;
    const number = String(index + 1).padStart(2, '0');
    return {id: `peer-${number}`, name: `Agent ${number}`, role: PEER_ROLE, harness: selected, model: model ?? defaultModel(selected)};
  });
}

export function validateTeam(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('A swarm needs 2–12 agents.');
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
