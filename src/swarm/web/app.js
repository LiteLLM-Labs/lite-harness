import { Constellation } from './assets/constellation.js';
import { HARNESS_NAMES, element, logo, modelLogo, identityLogos, shortModel, elapsed, richText, publicOutput, currentWork, stageDescription, consensusLabel, replaceText } from './assets/ui.js';

const $ = (selector) => document.querySelector(selector);
let state = { run: null, runs: [], defaults: {}, capabilities: [] };
let historicalRun = null;
let configuredTeam = null;
let editingTeam = [];
let selectedId = null;
let filterId = '';
let selectedResult = null;
let busy = false;
let defaultsApplied = false;
let lastRunId = null;
let feedSignature = '';
let resultsSignature = '';
let filterSignature = '';
let messageSignature = '';
let toastTimer;
let layoutPending = false;
const expandedEvents = new Set();
const cards = new Map();
const field = new Constellation($('#constellation'));

function defaultTeam() {
  return (state.defaults.team || []).map((agent) => ({ ...agent, status: 'queued' }));
}
function viewedRun() { return historicalRun || state.run; }
function displayAgents() { return viewedRun()?.agents || configuredTeam || defaultTeam(); }
function agentById(id) { return displayAgents().find((agent) => agent.id === id); }
function agentName(id) { return id === 'all' ? 'everyone' : id === 'user' ? 'You' : agentById(id)?.name || id || 'Swarm'; }
function harnessDefaultModel(harness) {
  return state.defaults.harnessModels?.[harness] ?? state.defaults.team?.find((agent) => agent.harness === harness)?.model ?? (harness === 'native' ? state.defaults.model || '' : '');
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${globalThis.__SWARM_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function runDuration() {
  const seconds = $('#timeout-select').value === 'custom' ? Number($('#custom-duration').value) * 60 : Number($('#timeout-select').value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error('Choose a work duration between 1 minute and 24 hours.');
  return seconds;
}
function updateDurationLabel() {
  $('#custom-duration-label').hidden = $('#timeout-select').value !== 'custom';
  try { $('#duration-label').textContent = `${runDuration() / 60} minutes of work`; }
  catch { $('#duration-label').textContent = 'Choose a duration'; }
}
function updateClock() {
  const run = viewedRun();
  if (!run) { $('#elapsed').textContent = 'READY WHEN YOU ARE'; return; }
  const spent = `${elapsed(run.startedAt, run.endedAt || Date.now())} ELAPSED`;
  $('#elapsed').textContent = run.status === 'running' && run.deadlineAt ? `${elapsed(Date.now(), run.deadlineAt)} LEFT · ${spent}` : spent;
}

function renderStatus(run, agents) {
  const running = run?.status === 'running';
  const currentRunning = state.run?.status === 'running';
  const electing = running && run.phase === 'electing';
  const active = agents.filter((agent) => ['running', 'working'].includes(agent.status)).length;
  const cycles = agents.reduce((total, agent) => total + (Number(agent.cycles) || 0), 0);
  const completed = agents.filter((agent) => agent.status === 'complete').length;
  const statusLabels = { running: 'THE SWARM IS WORKING', complete: 'WORK PERIOD COMPLETE', failed: 'THIS RUN NEEDS ATTENTION', stopped: 'SWARM STOPPED', interrupted: 'RUN INTERRUPTED' };
  $('#run-state').textContent = historicalRun ? 'FROM YOUR RECENT RUNS' : electing ? 'THE TEAM IS ELECTING ITS COORDINATOR' : statusLabels[run?.status] || 'INDEPENDENT MINDS. SHARED MOMENTUM.';
  $('#demo-label').hidden = !run?.demo;
  $('#run-dot').style.background = running ? 'var(--gold)' : run?.status === 'failed' ? '#df9898' : '';
  if (run) {
    $('#headline').classList.add('run-headline');
    $('#headline').textContent = run.task;
    $('#headline').title = run.task;
  } else {
    $('#headline').classList.remove('run-headline');
    $('#headline').replaceChildren(document.createTextNode('One task. '), element('span', '', agents.length === 10 ? 'Ten perspectives.' : 'Many perspectives.'));
    $('#headline').removeAttribute('title');
  }
  const captions = {
    running: electing ? 'Each agent votes. The counted result decides who coordinates.' : `${active} agents at work. New findings keep arriving while they collaborate.`,
    complete: 'The work period is complete. Explore every contribution and result.',
    failed: 'Read the conversation for details. Completed work stays available.',
    stopped: 'The swarm has stopped. Every contribution is still here.',
    interrupted: 'This run was interrupted. Its work has been preserved.',
  };
  $('#hero-caption').textContent = captions[run?.status] || 'The team elects its coordinator. Every agent keeps working.';
  $('#progress-text').textContent = run ? running ? `${active}/${agents.length} working · ${cycles} contributions` : `${completed}/${agents.length} complete · ${cycles} contributions` : `${agents.length || '…'} agents · concurrent work`;
  const coordinator = agents.find((agent) => agent.id === run?.coordinatorId);
  const voteCount = run?.election?.votes?.length || 0;
  const coordinatorKind = run?.coordinatorChanges?.length ? 'replacement' : run?.election?.method?.includes('fallback') ? 'fallback' : 'elected';
  $('#coordinator-label').textContent = coordinator ? `${coordinator.name} · ${coordinatorKind} coordinator` : electing ? `Election · ${voteCount}/${run.election?.eligibleVoters || agents.length} votes` : 'Coordinator elected by the team';
  $('#election-button').classList.toggle('elected', Boolean(coordinator));
  $('#stage-hint').textContent = historicalRun ? 'Viewing a saved run. Use Recent runs to return.' : 'Open any agent to see its full work and conversation.';
  $('#stream-label').replaceChildren(element('span', 'status-dot'), document.createTextNode(running ? 'LIVE' : run ? run.status.toUpperCase() : 'STANDING BY'));
  $('#run-button').hidden = currentRunning;
  $('#run-button').disabled = busy || !(configuredTeam || defaultTeam()).length;
  $('#stop-button').hidden = !currentRunning;
  $('#stop-button').disabled = busy;
  $('#task-input').disabled = currentRunning;
  $('#demo-button').disabled = currentRunning || busy;
  $('#team-button').disabled = currentRunning;
  $('#steering-input').disabled = !running || Boolean(historicalRun) || busy;
  $('#steering-button').disabled = !running || Boolean(historicalRun) || busy;
  $('#steering-note').textContent = running && !historicalRun ? 'Your guidance is shared with the team’s next work cycles.' : 'Your guidance joins the shared context.';
  $('#gateway-label').title = state.defaults.baseUrl || 'Gateway configured by your local CLI';
  $('#team-button-label').textContent = `Configure ${(configuredTeam || defaultTeam()).length || 'your'} agents`;
  updateDurationLabel();
  if (running && run.deadlineAt) $('#duration-label').textContent = `${elapsed(run.startedAt, run.deadlineAt)} ${run.demo ? 'demo playback' : 'work budget'}`;
  updateClock();
}

function renderCards(agents, run) {
  const ids = new Set(agents.map((agent) => agent.id));
  for (const [id, entry] of cards) {
    if (!ids.has(id)) { entry.node.remove(); cards.delete(id); }
  }
  for (const agent of agents) {
    const coordinator = agent.id === run?.coordinatorId;
    const output = currentWork(agent);
    const vote = run?.election?.votes?.find((entry) => entry.voterId === agent.id);
    const assignment = agent.assignment || agent.role || 'Waiting for an assignment.';
    const preview = output ? output.replace(/\s+/g, ' ').slice(-340) : vote ? `Voted for ${agentName(vote.candidateId)}. ${vote.reason || ''}` : run?.phase === 'electing' ? 'Considering the team and choosing a coordinator…' : run ? 'Waiting for a public contribution…' : 'Its actual work will appear here as it happens.';
    const replacement = coordinator && Boolean(run?.coordinatorChanges?.length || run?.election?.method?.includes('fallback'));
    const signature = JSON.stringify([agent.name, agent.harness, agent.model, agent.status, agent.cycles, agent.activity, assignment, preview, coordinator, replacement, selectedId]);
    let entry = cards.get(agent.id);
    if (!entry) {
      const node = element('button', 'agent-card');
      node.type = 'button';
      node.dataset.agentId = agent.id;
      node.addEventListener('click', () => openAgent(agent.id));
      entry = { node, signature: '' };
      cards.set(agent.id, entry);
      $('#graph').append(node);
    }
    if (signature === entry.signature) continue;
    entry.signature = signature;
    const button = entry.node;
    button.className = `agent-card ${agent.status || 'queued'}${coordinator ? ' coordinator' : ''}${selectedId === agent.id ? ' selected' : ''}`;
    button.setAttribute('aria-label', `Open ${agent.name}, ${HARNESS_NAMES[agent.harness] || agent.harness}, ${stageDescription(agent)}. Full output and transcript.`);
    const header = element('span', 'agent-card-header');
    const status = element('span', 'card-status');
    status.append(element('span', 'status-dot'));
    header.append(logo(agent.harness), element('span', 'agent-card-name', agent.name), status);
    const model = element('span', 'agent-card-model');
    model.append(modelLogo(agent.model, agent.harness), element('span', '', shortModel(agent.model, agent.harness)));
    model.title = `${HARNESS_NAMES[agent.harness] || agent.harness} · ${shortModel(agent.model, agent.harness)}`;
    const footer = element('span', 'card-footer');
    footer.append(element('span', '', `${Number(agent.cycles) || 0} cycles · ${stageDescription(agent)}`));
    if (coordinator) footer.append(element('span', 'coordinator-badge', replacement ? 'COORDINATOR' : 'ELECTED'));
    footer.append(element('span', 'open-detail', '↗'));
    button.replaceChildren(header, model, element('span', 'agent-assignment', assignment), element('span', `agent-preview${output || vote ? '' : ' waiting'}`, preview), footer);
  }
  scheduleFieldLayout();
}

function scheduleFieldLayout() {
  if (layoutPending) return;
  layoutPending = true;
  requestAnimationFrame(() => {
    layoutPending = false;
    const stage = $('#stage').getBoundingClientRect();
    if (!stage.width || !stage.height) return;
    const position = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: (rect.left + rect.width / 2 - stage.left) / stage.width * 1920, y: (rect.top + rect.height / 2 - stage.top) / stage.height * 1080 };
    };
    const agents = displayAgents().map((agent) => ({ ...agent, ...position(cards.get(agent.id).node) }));
    field.update(agents, selectedId, viewedRun()?.status === 'running', position($('#election-button')));
  });
}
new ResizeObserver(scheduleFieldLayout).observe($('#stage'));

function allEvents(run) {
  if (!run) return [];
  const events = [...(run.events || [])];
  const existing = new Set(events.map((event) => `${event.agentId || event.from}|${event.text}`));
  for (const message of run.messages || []) {
    if (existing.has(`${message.from}|${message.text}`)) continue;
    events.push({ ...message, agentId: message.from, toAgentId: message.to, type: message.kind || 'message' });
  }
  return events.sort((a, b) => Number(new Date(a.at)) - Number(new Date(b.at)));
}
function eventElement(event, run, full = false) {
  const agent = agentById(event.agentId || event.from);
  const isUser = event.agentId === 'user' || event.from === 'user' || event.role === 'user';
  const type = event.kind || event.type || 'message';
  const card = element('article', `event ${type}${isUser ? ' user' : ''}`);
  const header = element('div', 'event-header');
  header.append(identityLogos(agent));
  const name = agent ? element('button', 'event-name event-agent-link', agent.name) : element('span', 'event-name', isUser ? 'You' : 'Swarm');
  if (agent) name.addEventListener('click', () => openAgent(agent.id));
  header.append(name);
  const recipient = event.toAgentId || event.to;
  if (recipient && recipient !== 'all') header.append(element('span', 'event-recipient', `→ ${agentName(recipient)}`));
  if (type !== 'message') header.append(element('span', 'event-type', type));
  header.append(element('span', 'event-time', run?.startedAt ? `+${elapsed(run.startedAt, event.at)}` : ''));
  card.append(header);
  if (agent) card.append(element('div', 'event-model', `${HARNESS_NAMES[agent.harness]} · ${shortModel(agent.model, agent.harness)}`));
  const text = event.text || '';
  const expanded = full || expandedEvents.has(event.id);
  const body = element('div', `event-body${expanded ? '' : ' preview'}`);
  richText(body, text);
  card.append(body);
  if (event.proposalId) {
    const proposal = run?.proposals?.find((item) => item.id === event.proposalId);
    const consensus = proposal?.consensus || event.consensus;
    const count = consensusLabel(consensus);
    if (count) card.append(element('div', 'event-consensus', `${count} · ${Number(consensus.disagree) || 0} disagree · ${Number(consensus.abstain) || 0} abstain`));
  }
  if (text.length > 200 && !full) {
    const more = element('button', 'event-read-more', expanded ? 'Show less' : 'Read full message ↗');
    more.addEventListener('click', () => {
      if (expandedEvents.has(event.id)) expandedEvents.delete(event.id); else expandedEvents.add(event.id);
      feedSignature = '';
      renderFeed(viewedRun(), displayAgents());
    });
    card.append(more);
  }
  return card;
}
function renderFilter(agents) {
  const signature = agents.map((agent) => `${agent.id}:${agent.name}`).join('|');
  if (signature === filterSignature) return;
  filterSignature = signature;
  if (filterId && !agents.some((agent) => agent.id === filterId)) filterId = '';
  const options = [element('option', '', 'All agents')];
  options[0].value = '';
  for (const agent of agents) {
    const option = element('option', '', agent.name);
    option.value = agent.id;
    options.push(option);
  }
  $('#agent-filter').replaceChildren(...options);
  $('#agent-filter').value = filterId;
}
function renderFeed(run, agents) {
  renderFilter(agents);
  const events = allEvents(run).filter((event) => !filterId || event.agentId === filterId || event.toAgentId === filterId || event.toAgentId === 'all' || event.agentId === 'user' || !event.agentId);
  $('#event-count').textContent = `${events.length} EVENTS`;
  const signature = `${run?.id}|${filterId}|${events.length}|${events.at(-1)?.id || ''}|${events.at(-1)?.text || ''}`;
  if (signature === feedSignature || !run) return;
  feedSignature = signature;
  const panel = $('#conversation-panel');
  const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 60;
  const position = panel.scrollTop;
  $('#feed').replaceChildren(...events.map((event) => eventElement(event, run)));
  if (!events.length) $('#feed').append(element('p', 'dialog-intro', 'The team is preparing. Its first public messages will appear here.'));
  panel.scrollTop = stick ? panel.scrollHeight : position;
}

function resultEntries(run) {
  if (run?.results?.length) return run.results;
  return run?.result ? [{ id: `${run.id}-result`, at: run.endedAt || run.startedAt, agentId: run.coordinatorId, text: run.result, cycle: null }] : [];
}
function renderResults(run) {
  const results = resultEntries(run);
  $('#result-count').textContent = `${results.length} ${results.length === 1 ? 'UPDATE' : 'UPDATES'}`;
  const signature = JSON.stringify([run?.id, results]);
  if (signature === resultsSignature || !results.length) return;
  resultsSignature = signature;
  const panel = $('#human-feed');
  const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 60;
  const position = panel.scrollTop;
  panel.replaceChildren(...results.map((result) => {
    const agent = agentById(result.agentId);
    const card = element('article', 'result-card');
    const header = element('div', 'event-header');
    header.append(identityLogos(agent), element('span', 'event-name', agent?.name || 'Swarm'), element('span', 'event-type', 'FOR YOU'), element('span', 'event-time', `+${elapsed(run.startedAt, result.at)}`));
    const preview = element('div', 'result-preview');
    richText(preview, publicOutput(result.text) || result.text);
    const footer = element('div', 'result-card-footer');
    const consensus = consensusLabel(result.consensus);
    footer.append(element('span', consensus ? 'result-consensus' : 'result-cycle', consensus || `${result.cycle == null ? 'Shared result' : `Cycle ${result.cycle}`}${result.provisional ? ' · update' : ''}`));
    const open = element('button', 'quiet-button', 'Full result ↗');
    open.addEventListener('click', () => openResult(result));
    footer.append(open);
    card.append(header, preview, footer);
    return card;
  }));
  panel.scrollTop = stick ? panel.scrollHeight : position;
}
function openResult(result) {
  selectedResult = result;
  $('#result-detail').replaceChildren();
  richText($('#result-detail'), publicOutput(result.text) || result.text);
  const consensus = consensusLabel(result.consensus);
  $('#result-detail-meta').textContent = `${agentName(result.agentId)}${result.cycle == null ? '' : ` · cycle ${result.cycle}`}${consensus ? ` · ${consensus}` : ''}`;
  if (!$('#result-dialog').open) $('#result-dialog').showModal();
}

function openAgent(id) {
  selectedId = id;
  messageSignature = '';
  setAgentTab('output');
  renderAgentDetails();
  if (!$('#agent-dialog').open) $('#agent-dialog').showModal();
  renderCards(displayAgents(), viewedRun());
}
function setAgentTab(name) {
  for (const tabName of ['output', 'transcript', 'messages']) {
    const active = name === tabName;
    $(`#${tabName}-tab`).setAttribute('aria-selected', String(active));
    $(`#${tabName}-tab`).tabIndex = active ? 0 : -1;
    $(`#${tabName}-panel`).hidden = !active;
  }
}
function renderAgentDetails() {
  if (!selectedId) return;
  const agent = agentById(selectedId);
  if (!agent) return;
  const run = viewedRun();
  const identity = $('#agent-dialog-identity');
  const name = element('h2', '', agent.name);
  name.id = 'agent-dialog-title';
  identity.replaceChildren(identityLogos(agent), name);
  const coordinatorTitle = run?.coordinatorChanges?.length ? 'REPLACEMENT COORDINATOR' : run?.election?.method?.includes('fallback') ? 'FALLBACK COORDINATOR' : 'ELECTED COORDINATOR';
  $('#agent-dialog-meta').replaceChildren(element('span', '', HARNESS_NAMES[agent.harness] || agent.harness), element('span', '', shortModel(agent.model, agent.harness)), element('span', '', `${Number(agent.cycles) || 0} completed cycles`), ...(agent.id === run?.coordinatorId ? [element('span', 'coordinator-badge', coordinatorTitle)] : []));
  $('#agent-dialog-assignment').textContent = agent.assignment || agent.role || 'Waiting for an assignment.';
  replaceText($('#output-panel'), currentWork(agent) || 'No public output yet. The agent’s contribution will stream here.');
  replaceText($('#transcript-panel'), agent.transcript || currentWork(agent) || 'No public transcript yet.');
  $('#output-panel').classList.add('rich-text');
  $('#transcript-panel').classList.add('rich-text');
  $('#agent-detail-status').textContent = stageDescription(agent);
  const messages = allEvents(run).filter((event) => event.agentId === agent.id || event.toAgentId === agent.id || event.toAgentId === 'all' || event.agentId === 'user');
  const signature = `${agent.id}:${messages.length}:${messages.at(-1)?.id || ''}`;
  if (signature !== messageSignature) {
    messageSignature = signature;
    const position = $('#messages-panel').scrollTop;
    $('#messages-panel').replaceChildren(...messages.map((event) => eventElement(event, run, true)));
    if (!messages.length) $('#messages-panel').append(element('p', '', 'Messages to and from this agent will appear here.'));
    $('#messages-panel').scrollTop = position;
  }
}
function renderElection() {
  const run = viewedRun();
  const election = run?.election;
  const coordinator = agentById(run?.coordinatorId);
  const votes = election?.votes || [];
  const replacement = run?.coordinatorChanges?.at(-1);
  const methods = { plurality: 'The candidate with the most votes was elected.', 'plurality-lexical-tiebreak': 'The top candidates tied. Their IDs determined the tie-break.', 'no-votes-lexical-fallback': 'No valid votes arrived. The first eligible ID was selected as a fallback.' };
  $('#election-summary').textContent = replacement ? `${coordinator?.name || agentName(replacement.to)} replaced ${agentName(replacement.from)} using the original ballots among available agents. No new vote was held. ${replacement.reason || ''}` : coordinator ? `${coordinator.name} coordinates this run. ${methods[election?.method] || ''} ${votes.length} votes were counted.` : election ? `${votes.length} of ${election.eligibleVoters || displayAgents().length} agents have voted. The coordinator has not been selected yet.` : 'Every run begins with a team election. There is no fixed leader; the counted vote selects the coordinator.';
  const tally = Object.entries(replacement?.tally || election?.tally || {}).sort((a, b) => b[1] - a[1]);
  $('#election-tally').replaceChildren(...tally.map(([id, count]) => {
    const chip = element('span', `tally-chip${id === run?.coordinatorId ? ' winner' : ''}`, agentName(id));
    chip.append(element('b', '', count));
    return chip;
  }));
  const voteCards = votes.map((vote) => {
    const card = element('article', 'vote-card');
    card.append(element('div', 'vote-card-header', `${agentName(vote.voterId)} → ${agentName(vote.candidateId)}`), element('p', '', vote.reason || 'No reason supplied.'));
    return card;
  });
  for (const vote of election?.abstentions || []) {
    const card = element('article', 'vote-card');
    card.append(element('div', 'vote-card-header', `${agentName(vote.voterId)} · no valid vote`), element('p', '', vote.reason || 'Abstained.'));
    voteCards.push(card);
  }
  $('#election-votes').replaceChildren(...voteCards);
}

function clearHumanFeed() {
  const empty = element('div', 'empty-results');
  empty.append(element('span', 'small-orbit', '✦'), element('h3', '', 'Useful work, as it emerges.'), element('p', '', 'The elected coordinator shares results here while the whole team keeps working.'));
  $('#human-feed').replaceChildren(empty);
}
function render() {
  const run = viewedRun();
  const agents = displayAgents();
  if (run?.id !== lastRunId) {
    lastRunId = run?.id;
    selectedId = null;
    filterId = '';
    feedSignature = resultsSignature = filterSignature = messageSignature = '';
    expandedEvents.clear();
    if ($('#agent-dialog').open) $('#agent-dialog').close();
    clearHumanFeed();
  }
  renderStatus(run, agents);
  renderCards(agents, run);
  renderFeed(run, agents);
  renderResults(run);
  if ($('#agent-dialog').open) renderAgentDetails();
  if ($('#election-dialog').open) renderElection();
}
function receiveState(next) {
  state = { ...state, ...next };
  if (!defaultsApplied && state.defaults.team?.length) {
    defaultsApplied = true;
    const duration = Number(state.defaults.duration) || 600;
    const option = [...$('#timeout-select').options].find((item) => Number(item.value) === duration);
    $('#timeout-select').value = option ? option.value : 'custom';
    $('#custom-duration').value = String(duration / 60);
    updateDurationLabel();
  }
  render();
}

function openTeam() {
  editingTeam = (configuredTeam || defaultTeam()).map((agent) => ({ ...agent }));
  const capabilityMap = new Map((state.capabilities || []).map((capability) => [capability.id, capability]));
  const harnesses = [...new Set([...Object.keys(HARNESS_NAMES).filter((id) => id !== 'claude-code'), ...editingTeam.map((agent) => agent.harness)])];
  $('#team-editor').replaceChildren(...editingTeam.map((agent) => {
    const row = element('div', 'team-config-row');
    const name = element('span', 'team-role', agent.name);
    name.append(element('small', '', 'Independent peer'));
    const harnessLabel = element('label', '', 'Harness');
    const select = element('select');
    select.id = `harness-${agent.id}`;
    select.setAttribute('aria-label', `${agent.name} harness`);
    for (const id of harnesses) {
      const capability = capabilityMap.get(id);
      const option = element('option', '', `${HARNESS_NAMES[id] || id}${capability?.available === false ? ' · unavailable' : ''}`);
      option.value = id;
      option.disabled = capability?.available === false;
      select.append(option);
    }
    select.value = agent.harness;
    const modelLabel = element('label', '', 'Model');
    const model = element('input');
    model.id = `model-${agent.id}`;
    model.type = 'text';
    model.value = agent.model || '';
    model.placeholder = 'Harness default';
    model.setAttribute('aria-label', `${agent.name} model`);
    select.addEventListener('change', () => { model.value = harnessDefaultModel(select.value); saveTeam(); });
    model.addEventListener('input', saveTeam);
    harnessLabel.append(select);
    modelLabel.append(model);
    row.append(name, harnessLabel, modelLabel);
    return row;
  }));
  $('#team-button').setAttribute('aria-expanded', 'true');
  $('#team-dialog').showModal();
}
function saveTeam() {
  configuredTeam = editingTeam.map((agent) => ({ ...agent, harness: $(`#harness-${CSS.escape(agent.id)}`).value, model: $(`#model-${CSS.escape(agent.id)}`).value.trim(), status: 'queued' }));
  if (!viewedRun()) render();
}
async function startRun(demo = false) {
  const task = $('#task-input').value.trim();
  if (!demo && !task) { $('#task-input').focus(); return; }
  if (busy || state.run?.status === 'running') return;
  busy = true;
  render();
  try {
    const body = demo ? { demo: true } : {
      task,
      agents: (configuredTeam || defaultTeam()).map(({ id, name, role, harness, model }) => ({ id, name, role, harness, model })),
      timeoutSeconds: runDuration(),
      toolsEnabled: $('#tools-toggle').checked,
    };
    const response = await api('/api/run', body);
    historicalRun = null;
    selectedId = null;
    if (response.run) receiveState(response);
    else receiveState(await api('/api/state'));
    if (demo) $('#task-input').value = '';
  } catch (error) { toast(error.message); }
  finally { busy = false; render(); }
}
function renderHistory() {
  const runs = state.runs || [];
  const list = $('#history-list');
  if (!runs.length) { list.replaceChildren(element('p', 'dialog-intro', 'Your completed and interrupted runs will live here.')); return; }
  list.replaceChildren(...runs.map((run) => {
    const row = element('button', 'history-row');
    const metadata = element('span', 'history-meta');
    const date = new Date(run.startedAt);
    metadata.append(element('span', '', `${run.status}${run.demo ? ' · demo' : ''}`), element('span', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
    row.append(element('span', 'history-title', run.task || 'Untitled run'), metadata);
    row.addEventListener('click', async () => {
      try {
        const result = await api(`/api/runs/${encodeURIComponent(run.id)}`);
        historicalRun = result.run || result;
        $('#history-dialog').close();
        render();
      } catch (error) { toast(error.message); }
    });
    return row;
  }));
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text || ''); toast('Copied.'); }
  catch { toast('Your browser could not copy this. You can select and copy the text.'); }
}

$('#run-form').addEventListener('submit', (event) => { event.preventDefault(); startRun(); });
$('#demo-button').addEventListener('click', () => startRun(true));
$('#empty-demo-button').addEventListener('click', () => startRun(true));
$('#team-button').addEventListener('click', openTeam);
$('#reset-team').addEventListener('click', () => { configuredTeam = null; $('#team-dialog').close(); openTeam(); render(); });
$('#team-dialog').addEventListener('close', () => { $('#team-button').setAttribute('aria-expanded', 'false'); updateDurationLabel(); });
$('#agent-dialog').addEventListener('close', () => { selectedId = null; renderCards(displayAgents(), viewedRun()); });
$('#timeout-select').addEventListener('change', updateDurationLabel);
$('#custom-duration').addEventListener('input', updateDurationLabel);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close());
$('#history-button').addEventListener('click', () => { renderHistory(); $('#history-dialog').showModal(); });
$('#back-live').addEventListener('click', () => { historicalRun = null; $('#history-dialog').close(); render(); });
$('#agent-filter').addEventListener('change', () => { filterId = $('#agent-filter').value; feedSignature = ''; renderFeed(viewedRun(), displayAgents()); });
$('#election-button').addEventListener('click', () => { renderElection(); $('#election-dialog').showModal(); });
for (const name of ['output', 'transcript', 'messages']) $(`#${name}-tab`).addEventListener('click', () => setAgentTab(name));
$('.view-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const names = ['output', 'transcript', 'messages'];
  const current = names.findIndex((name) => $(`#${name}-tab`).getAttribute('aria-selected') === 'true');
  const next = names[(current + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
  setAgentTab(next);
  $(`#${next}-tab`).focus();
});
$('#copy-result').addEventListener('click', () => copyText(publicOutput(selectedResult?.text) || selectedResult?.text));
$('#copy-agent-output').addEventListener('click', () => copyText($('#transcript-tab').getAttribute('aria-selected') === 'true' ? agentById(selectedId)?.transcript : currentWork(agentById(selectedId) || {})));
$('#stop-button').addEventListener('click', async () => {
  busy = true;
  render();
  try { await api('/api/stop', {}); receiveState(await api('/api/state')); }
  catch (error) { toast(error.message); }
  finally { busy = false; render(); }
});
$('#steering-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#steering-input').value.trim();
  if (!text || busy) return;
  busy = true;
  render();
  try {
    await api('/api/message', { text });
    $('#steering-input').value = '';
    receiveState(await api('/api/state'));
    toast('Guidance added to the shared context.');
  } catch (error) { toast(error.message); }
  finally { busy = false; render(); }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    if (document.activeElement === $('#steering-input')) $('#steering-form').requestSubmit();
    else if (!$('#task-input').disabled) startRun();
  }
});

function connectionStatus(online) {
  $('#connection').replaceChildren(element('span', `status-dot${online ? '' : ' offline'}`), document.createTextNode(online ? 'connected locally' : 'reconnecting'));
}
let streamRetryDelay = 1000;
let streamRetryTimer;
let streamController;
let pageClosing = false;
async function connectUpdates() {
  streamController = new AbortController();
  try {
    const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${globalThis.__SWARM_TOKEN}` }, signal: streamController.signal });
    if (response.status === 401 || response.status === 403) { connectionStatus(false); toast('The local session changed. Reload this page to reconnect.'); return; }
    if (!response.ok || !response.body) throw new Error('Live stream unavailable');
    connectionStatus(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!pageClosing) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n');
        if (!lines.includes('event: state')) continue;
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        receiveState(JSON.parse(data));
        streamRetryDelay = 1000;
      }
    }
  } catch (error) {
    streamController.abort();
    if (pageClosing || error.name === 'AbortError') return;
  }
  if (pageClosing) return;
  connectionStatus(false);
  streamRetryTimer = setTimeout(connectUpdates, streamRetryDelay);
  streamRetryDelay = Math.min(streamRetryDelay * 2, 30000);
}
window.addEventListener('pagehide', () => { pageClosing = true; clearTimeout(streamRetryTimer); streamController?.abort(); });
render();
api('/api/state').then(receiveState).catch((error) => toast(`Cannot connect to the local swarm: ${error.message}`));
connectUpdates();
setInterval(updateClock, 1000);
