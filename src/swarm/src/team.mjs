export const HARNESSES = ['native', 'codex', 'claude'];

export function defaultModel(harness, env = process.env) {
  if (harness === 'native') return env.LITELLM_MODEL || 'gpt-4.1-mini';
  return harness === 'claude' ? 'sonnet' : '';
}

export function defaultTeam({harness = 'native', model = defaultModel(harness)} = {}) {
  return [
    {id: 'scout', name: 'Scout', role: 'Explore the task and inspect relevant context. Find requirements, evidence, and constraints. Do not modify files.', harness, model, dependsOn: []},
    {id: 'builder', name: 'Builder', role: 'Develop the solution. If file writes are enabled, implement the requested deliverable. Otherwise provide a concrete proposal. State what you verified.', harness, model, dependsOn: []},
    {id: 'critic', name: 'Critic', role: 'Review the scout and builder contributions. Identify concrete defects, contradictions, and missing evidence. Do not modify files.', harness, model, dependsOn: ['scout', 'builder']},
    {id: 'lead', name: 'Lead', role: 'Synthesize the team contributions into the final useful answer. Account for review findings and distinguish completed work from proposals. Do not modify files.', harness, model, dependsOn: ['scout', 'builder', 'critic']},
  ];
}

export function validateTeam(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('A swarm needs 2–12 agents.');
  const ids = new Set();
  const team = input.map((agent) => {
    if (!agent || typeof agent !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(agent.id)) throw new Error('Agent IDs must use lowercase letters, digits, and hyphens.');
    if (ids.has(agent.id)) throw new Error(`Duplicate agent ID: ${agent.id}`);
    ids.add(agent.id);
    if (!HARNESSES.includes(agent.harness)) throw new Error(`Unknown harness: ${agent.harness}`);
    if (typeof agent.name !== 'string' || !agent.name.trim() || agent.name.length > 60) throw new Error('Each agent needs a name (60 characters max).');
    if (typeof agent.role !== 'string' || !agent.role.trim() || agent.role.length > 2000) throw new Error('Each agent needs a role (2,000 characters max).');
    if (agent.model != null && (typeof agent.model !== 'string' || agent.model.length > 200)) throw new Error('Invalid model name.');
    const dependsOn = agent.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string')) throw new Error('dependsOn must be a list of agent IDs.');
    return {id: agent.id, name: agent.name.trim(), role: agent.role.trim(), harness: agent.harness, model: agent.model ?? defaultModel(agent.harness), dependsOn: [...new Set(dependsOn)]};
  });
  const seen = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new Error('Agent dependencies must not form a cycle.');
    const agent = team.find((item) => item.id === id);
    if (!agent) throw new Error(`Unknown dependency: ${id}`);
    visiting.add(id);
    agent.dependsOn.forEach(visit);
    visiting.delete(id);
    seen.add(id);
  };
  team.forEach((agent) => visit(agent.id));
  const sinks = team.filter((agent) => !team.some((other) => other.dependsOn.includes(agent.id)));
  if (sinks.length !== 1) throw new Error('Connect all agents to one final synthesizer using dependsOn.');
  return team;
}

export function validateTask(task) {
  if (typeof task !== 'string' || !task.trim() || task.length > 16000) throw new Error('Enter a task between 1 and 16,000 characters.');
  return task.trim();
}
