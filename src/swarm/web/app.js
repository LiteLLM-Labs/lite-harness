import { Constellation } from './assets/constellation.js';
import { brainLayout, resizeTeam } from './assets/team-layout.js';
import { groupChatEntries } from './assets/chat-feed.js';
import { HARNESS_NAMES, element, logo, modelLogo, identityLogos, shortModel, elapsed, richText, publicOutput, currentWork, agentPresence, stageDescription, consensusLabel, replaceText } from './assets/ui.js';

const $ = (selector) => document.querySelector(selector);
let state = { run: null, runs: [], defaults: {}, capabilities: [] };
let historicalRun = null;
let draftMode = false;
let parentRun = null;
let brainView = false;
let contentView = 'chat';
const contentScroll = {chat: 0, results: 0};
const groupRows = new Map();
const expandedMessages = new Set();
let inspectorOpen = false;
let sidebarSignature = '';
let navigationRevision = 0;
let requestedChatId = null;
let pendingSubmission = null;
const agentRows = new Map();
let configuredTeam = null;
let editingTeam = [];
let addTargetId = null;
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
function maxAgents() { return Number(state.defaults.maxAgents) || 100; }
function viewedRun() { return draftMode ? null : historicalRun || state.run; }
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
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
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
  const active = agents.filter((agent) => agentPresence(agent, run).active).length;
  const statusLabels = { running: 'THE SWARM IS WORKING', complete: 'WORK PERIOD COMPLETE', failed: 'THIS RUN NEEDS ATTENTION', stopped: 'SWARM STOPPED', interrupted: 'RUN INTERRUPTED' };
  $('#run-state').textContent = draftMode ? parentRun ? 'CONTINUE THE CONVERSATION' : 'A NEW CONVERSATION' : historicalRun ? 'FROM YOUR RECENT RUNS' : electing ? 'THE TEAM IS ELECTING ITS COORDINATOR' : statusLabels[run?.status] || 'INDEPENDENT MINDS. SHARED MOMENTUM.';
  $('#demo-label').hidden = !run?.demo;
  $('#run-dot').style.background = running ? 'var(--gold)' : run?.status === 'failed' ? '#df9898' : '';
  if (run) {
    $('#headline').classList.add('run-headline');
    $('#headline').textContent = run.task;
    $('#headline').title = run.task;
  } else {
    $('#headline').classList.remove('run-headline');
    $('#headline').replaceChildren(document.createTextNode('Many minds. '), element('span', '', 'One shared direction.'));
    $('#headline').removeAttribute('title');
  }
  $('#hero-caption').textContent = electing ? 'The peers are choosing their leader.' : running ? 'Your swarm is active.' : run ? 'This swarm is inactive.' : 'Start a conversation to bring the swarm online.';
  $('#progress-text').textContent = `${active} active · ${agents.length - active} inactive`;
  const coordinator = agents.find((agent) => agent.id === run?.coordinatorId);
  $('#coordinator-label').textContent = coordinator ? `Leader: ${coordinator.name}` : electing ? 'Choosing leader' : 'No leader';
  $('#election-button').classList.toggle('elected', Boolean(coordinator));
  $('#stage-hint').textContent = historicalRun ? 'Viewing a saved run. Use Recent runs to return.' : 'Open any agent to see its full work and conversation.';
  $('#stream-label').replaceChildren(element('span', 'status-dot'), document.createTextNode(running ? 'LIVE' : run ? run.status.toUpperCase() : 'STANDING BY'));
  $('#run-button').hidden = false;
  $('#run-button').disabled = busy || !(configuredTeam || defaultTeam()).length;
  $('#stop-button').hidden = !running;
  $('#stop-button').disabled = busy;
  $('#task-input').disabled = busy && !draftMode;
  $('#task-input').placeholder = running ? 'Add context or redirect this swarm…' : run || parentRun ? 'Message your swarm to continue…' : 'Give your swarm something to work on…';
  $('#demo-button').disabled = busy;
  $('#team-button').disabled = currentRunning && !draftMode;
  $('#continue-chat-button').hidden = true;
  $('#draft-context').hidden = !draftMode || !parentRun;
  $('#draft-context-text').textContent = parentRun ? `Following up on: ${parentRun.task}` : '';
  $('#return-chat-button').hidden = !state.run && !parentRun;
  $('#stop-button').title = draftMode && currentRunning ? 'Stop the swarm in your other chat' : 'Stop this swarm';
  $('#steering-input').disabled = !run || busy;
  $('#steering-button').disabled = !run || busy;
  $('#steering-input').placeholder = run && !running ? 'Message this swarm to continue…' : 'Guide the team…';
  $('#steering-note').textContent = running ? 'Your guidance is shared with the team’s next work cycles.' : run ? 'Your next message continues with this team’s context.' : 'Your guidance joins the shared context.';
  $('#gateway-label').title = state.defaults.baseUrl || 'Gateway configured by your local CLI';
  $('#team-button-label').textContent = `${(running ? agents.length : configuredTeam?.length || agents.length) || 'Your'} agents`;
  for (const button of document.querySelectorAll('[data-add-agents]')) {
    button.hidden = !running;
    button.disabled = busy || !state.defaults.maxAgents || agents.length >= maxAgents();
    button.title = !state.defaults.maxAgents ? 'Server update pending; the current swarm keeps working.' : agents.length >= maxAgents() ? `This swarm has reached the ${maxAgents()}-agent limit.` : 'Add peers to this swarm';
  }
  if ($('#add-agents-dialog').open && (!running || run.id !== addTargetId)) $('#add-agents-dialog').close();
  updateDurationLabel();
  if (running && run.deadlineAt) $('#duration-label').textContent = `${elapsed(run.startedAt, run.deadlineAt)} ${run.demo ? 'demo playback' : 'work budget'}`;
  updateClock();
}

function newChat(followUp = false) {
  navigationRevision += 1;
  requestedChatId = null;
  const prior = followUp ? viewedRun() : null;
  parentRun = prior;
  configuredTeam = prior ? prior.agents.map(({id, name, role, harness, model}) => ({id, name, role, harness, model, status: 'queued'})) : null;
  draftMode = true;
  historicalRun = null;
  selectedId = null;
  $('#task-input').value = '';
  contentView = 'chat';
  contentScroll.chat = contentScroll.results = 0;
  setView(false);
  showInspector(false);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  lastRunId = null;
  render();
  $('#task-input').focus();
  $('#task-input').scrollIntoView({block: 'nearest', behavior: 'smooth'});
}

function setView(spatial) {
  brainView = spatial;
  document.body.classList.toggle('brain-mode', spatial);
  $('#stage').hidden = !spatial;
  $('#brain-view-button').setAttribute('aria-pressed', String(spatial));
  $('#chat-view-button').setAttribute('aria-pressed', String(!spatial && contentView === 'chat'));
  $('#results-view-button').setAttribute('aria-pressed', String(!spatial && contentView === 'results'));
  updateContentVisibility();
  if (spatial) showInspector(false);
  scheduleFieldLayout();
}

function updateContentVisibility() {
  const results = brainView || contentView === 'results';
  $('#group-feed').hidden = results;
  $('#human-feed').hidden = !results;
  $('#conversation-label').textContent = results ? 'Results for you' : 'Group conversation';
  $('#conversation-label').hidden = !viewedRun();
  $('#chat-scroll').setAttribute('aria-label', results ? 'Results from the swarm' : 'Group conversation');
}
function showContent(view) {
  if (!brainView) contentScroll[contentView] = $('#chat-scroll').scrollTop;
  contentView = view;
  setView(false);
  render();
  $('#chat-scroll').scrollTop = contentScroll[view];
}

function showInspector(open) {
  if (open && brainView) setView(false);
  inspectorOpen = open;
  $('#inspector').hidden = !open;
  $('#workspace').classList.toggle('with-inspector', open);
  $('#agents-view-button').setAttribute('aria-expanded', String(open));
}

async function selectChat(id) {
  requestedChatId = id;
  const revision = ++navigationRevision;
  try {
    const next = await api('/api/select', {id});
    if (revision !== navigationRevision) return;
    const snapshot = next.run ? next : await api('/api/state');
    if (revision !== navigationRevision) return;
    draftMode = false;
    parentRun = null;
    configuredTeam = null;
    historicalRun = null;
    $('#task-input').value = '';
    receiveState(snapshot);
  } catch (error) { toast(error.message); }
}

function renderChat(run, agents) {
  $('#chat-title').textContent = run?.task || (parentRun ? 'Follow-up' : 'New chat');
  $('#chat-title').title = run?.task || 'New chat';
  $('#chat-welcome').hidden = Boolean(run);
  $('#chat-user-message').hidden = !run;
  $('#chat-task').textContent = run?.task || '';
  $('#agent-overview').hidden = !run;
  $('#agents-count').textContent = agents.length;
  $('#inspector-count').textContent = agents.length;
  const working = agents.filter((agent) => agentPresence(agent, run).active).length;
  const leader = agents.find((agent) => agent.id === run?.coordinatorId);
  $('#overview-title').textContent = `${agents.length} agents in this conversation`;
  $('#overview-detail').textContent = `${working} active · ${leader ? `Leader: ${leader.name}` : run?.phase === 'electing' ? 'Choosing a leader' : 'No leader'} · View their work`;
  $('#overview-logos').replaceChildren(...agents.map((agent) => logo(agent.harness)));
  $('#chat-run-status').hidden = !run;
  updateContentVisibility();
  $('#chat-run-status').textContent = run?.status === 'running' ? 'The team is working. You can send more context below.' : run?.status === 'complete' ? 'Work period complete. Message your swarm to continue with its context.' : run ? `This swarm is ${run.status}. Send a message to continue with its context.` : '';
  const signature = JSON.stringify([state.runs, run?.id, draftMode]);
  if (signature !== sidebarSignature) {
    sidebarSignature = signature;
    const rows = (state.runs || []).map((item) => {
      const button = element('button', `sidebar-chat${item.id === run?.id ? ' active' : ''}`);
      button.dataset.runId = item.id;
      button.append(element('span', 'sidebar-chat-title', item.task || 'Untitled chat'), element('span', `sidebar-status ${item.status}`, item.status === 'running' ? '◌' : ''));
      button.title = `${item.task} · ${item.status}`;
      button.addEventListener('click', () => selectChat(item.id));
      return button;
    });
    $('#sidebar-chats').replaceChildren(...(rows.length ? rows : [element('p', 'sidebar-empty', 'Your conversations will appear here.')]));
  }
  const ids = new Set(agents.map((agent) => agent.id));
  for (const [id, entry] of agentRows) if (!ids.has(id)) { entry.node.remove(); agentRows.delete(id); }
  for (const agent of agents) {
    let entry = agentRows.get(agent.id);
    if (!entry) {
      const node = element('button', 'agent-list-row');
      node.addEventListener('click', () => openAgent(agent.id));
      entry = {node, signature: ''};
      agentRows.set(agent.id, entry);
      $('#agent-list').append(node);
    }
    const output = currentWork(agent);
    const signature = JSON.stringify([agent.name, agent.harness, agent.model, agent.status, agent.activity, agent.cycles, output]);
    if (entry.signature === signature) continue;
    entry.signature = signature;
    entry.node.className = `agent-list-row ${agent.status}`;
    const text = element('span', 'agent-list-text');
    const heading = element('span', 'agent-list-heading');
    heading.append(element('strong', '', agent.name), modelLogo(agent.model, agent.harness));
    text.append(heading, element('span', 'agent-list-state', `${stageDescription(agent)} · ${agent.cycles || 0} cycles`), element('span', 'agent-list-preview', output || (run ? agent.assignment || agent.role : 'Chooses a role once you share your task.')));
    entry.node.replaceChildren(logo(agent.harness), text, element('span', 'agent-list-arrow', '↗'));
  }
}

function renderCards(agents, run) {
  const ids = new Set(agents.map((agent) => agent.id));
  for (const [id, entry] of cards) {
    if (!ids.has(id)) { entry.node.remove(); cards.delete(id); }
  }
  for (const agent of agents) {
    const presence = agentPresence(agent, run);
    const signature = JSON.stringify([agent.name, agent.harness, agent.model, presence, selectedId]);
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
    button.className = `agent-card presence-${presence.active ? 'active' : 'inactive'}${presence.leader ? ' coordinator' : ''}${selectedId === agent.id ? ' selected' : ''}`;
    button.setAttribute('aria-label', `Open ${agent.name}${presence.leader ? ', leader' : ''}, ${presence.label}. Full output and transcript.`);
    const art = element('span', 'agent-node-art');
    const status = element('span', 'card-status');
    status.append(element('span', 'status-dot'));
    art.append(logo(agent.harness), status);
    const header = element('span', 'agent-card-header');
    header.append(element('span', 'agent-card-name', agent.name), modelLogo(agent.model, agent.harness));
    const activity = element('span', 'node-presence');
    activity.append(element('span', 'status-dot'), document.createTextNode(presence.label));
    const work = element('span', 'node-work');
    work.append(header, activity);
    button.title = `${agent.name}${presence.leader ? ' · Leader' : ''} · ${presence.label}\n${HARNESS_NAMES[agent.harness]} · ${shortModel(agent.model, agent.harness)}\nClick for full work and conversation.`;
    button.replaceChildren(...(presence.leader ? [element('span', 'node-leader-tag', 'LEADER')] : []), art, work);
  }
  scheduleFieldLayout();
}

function scheduleFieldLayout() {
  if (layoutPending) return;
  layoutPending = true;
  requestAnimationFrame(() => {
    layoutPending = false;
    const stageElement = $('#stage');
    let stage = stageElement.getBoundingClientRect();
    if (!stage.width || !stage.height) return;
    const agentsToPosition = displayAgents();
    const expanded = agentsToPosition.length > 10;
    document.body.classList.toggle('large-brain', expanded);
    let layout = brainLayout(agentsToPosition.length, stage.width, stage.height);
    if (expanded) stageElement.style.setProperty('--brain-height', `${layout.height}px`);
    else stageElement.style.removeProperty('--brain-height');
    $('#workspace').style.setProperty('--brain-height', expanded ? `${layout.height}px` : '');
    stage = stageElement.getBoundingClientRect();
    layout = brainLayout(agentsToPosition.length, stage.width, stage.height);
    agentsToPosition.forEach((agent, index) => {
      const node = cards.get(agent.id)?.node;
      if (!node) return;
      node.style.left = `${layout.points[index].x}px`;
      node.style.top = `${layout.points[index].y}px`;
    });
    $('#election-button').style.left = '50%';
    $('#election-button').style.top = `${layout.hubY}px`;
    const position = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: (rect.left + rect.width / 2 - stage.left) / stage.width * 1920, y: (rect.top + rect.height / 2 - stage.top) / stage.height * 1080 };
    };
    const agents = displayAgents().map((agent) => ({ ...agent, status: agentPresence(agent, viewedRun()).active ? 'running' : 'queued', ...position(cards.get(agent.id).node.querySelector('.agent-node-art')) }));
    field.update(agents, selectedId, viewedRun()?.status === 'running', position($('#election-button .hub-symbol')));
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

const MESSAGE_LABELS = {contribution: 'Contribution', election: 'Leader vote', proposal: 'Proposal', vote: 'Vote', assignment: 'Assignment', identity: 'Introduction', membership: 'Team change', coordination: 'Coordination'};
function groupMessage(message, run) {
  const agent = agentById(message.from);
  const isUser = message.from === 'user';
  const presence = agent ? agentPresence(agent, run) : null;
  const row = element('article', `group-message${isUser ? ' group-user' : ''}${message.streaming ? ' group-streaming' : ''}`);
  row.dataset.messageId = message.id;
  if (agent) row.append(identityLogos(agent));
  const main = element('div', 'group-message-main');
  const header = element('div', 'group-message-header');
  const name = element(agent ? 'button' : 'span', 'group-author', isUser ? 'You' : agent?.name || message.from || 'Swarm');
  if (agent) name.addEventListener('click', () => openAgent(agent.id));
  header.append(name);
  if (presence?.leader) {
    const leader = element('span', 'group-leader', 'Leader');
    leader.title = 'Current elected leader';
    header.append(leader);
  }
  if (presence) {
    const status = element('span', `group-presence${presence.active ? ' active' : ''}`, presence.label);
    status.prepend(element('span', 'status-dot'));
    header.append(status);
  }
  if (message.to && message.to !== 'all') header.append(element('span', 'group-recipient', `→ ${agentName(message.to)}`));
  if (message.at != null) header.append(element('span', 'group-time', `+${elapsed(run.startedAt, message.at)}`));
  main.append(header);
  if (agent) main.append(element('div', 'group-model', `${HARNESS_NAMES[agent.harness]} · ${shortModel(agent.model, agent.harness)}`));
  const bubble = element('div', 'group-bubble');
  const label = message.streaming ? 'Writing…' : message.partial ? 'Partial contribution' : MESSAGE_LABELS[message.kind];
  if (label) bubble.append(element('div', 'group-kind', label));
  const collapsible = message.text.length > 400 || message.text.split('\n').length > 8;
  const body = element('div', `group-message-text${collapsible && !expandedMessages.has(message.id) ? ' collapsed' : ''}`);
  if (message.pending) body.append(element('span', 'group-writing', 'Composing a public update…'));
  else richText(body, message.text);
  bubble.append(body);
  if (message.proposalId) {
    const proposal = run.proposals?.find((item) => item.id === message.proposalId);
    const count = consensusLabel(proposal?.consensus || message.consensus);
    if (count) bubble.append(element('div', 'group-consensus', count));
  }
  if (collapsible) {
    const expand = element('button', 'group-expand', expandedMessages.has(message.id) ? 'Show less' : 'Read full message');
    expand.addEventListener('click', () => {
      if (expandedMessages.has(message.id)) expandedMessages.delete(message.id); else expandedMessages.add(message.id);
      groupRows.get(message.id).signature = '';
      renderGroupChat(viewedRun());
    });
    bubble.append(expand);
  }
  main.append(bubble);
  row.append(main);
  return row;
}
function renderGroupChat(run) {
  const messages = groupChatEntries(run);
  const panel = $('#chat-scroll');
  const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 70;
  const position = panel.scrollTop;
  const anchor = [...$('#group-feed').children].find((node) => node.getBoundingClientRect().bottom > panel.getBoundingClientRect().top);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const ids = new Set(messages.map((message) => message.id));
  for (const [id] of groupRows) if (!ids.has(id)) { groupRows.delete(id); expandedMessages.delete(id); }
  const rows = messages.map((message) => {
    const agent = agentById(message.from);
    const consensus = run?.proposals?.find((proposal) => proposal.id === message.proposalId)?.consensus;
    const signature = JSON.stringify([message, agent?.name, agent?.harness, agent?.model, agent && agentPresence(agent, run), consensus]);
    let entry = groupRows.get(message.id);
    if (!entry || signature !== entry.signature) {
      entry = {signature, node: groupMessage(message, run)};
      groupRows.set(message.id, entry);
    }
    return entry.node;
  });
  const feed = $('#group-feed');
  const retained = new Set(rows);
  for (const child of [...feed.children]) if (!retained.has(child)) child.remove();
  let cursor = feed.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else feed.insertBefore(row, cursor);
  }
  if (!messages.length && run) feed.replaceChildren(element('p', 'group-empty', 'The team’s first messages will appear here. Each peer speaks in its own name.'));
  if (!brainView && contentView === 'chat') {
    if (stick) panel.scrollTop = panel.scrollHeight;
    else if (anchor?.isConnected) panel.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else panel.scrollTop = position;
  }
}

function resultEntries(run) {
  if (run?.results?.length) return run.results;
  return run?.result ? [{ id: `${run.id}-result`, at: run.endedAt || run.startedAt, agentId: run.coordinatorId, text: run.result, cycle: null }] : [];
}
function renderResults(run) {
  const results = resultEntries(run);
  const timeline = results;
  $('#result-count').textContent = `${results.length} ${results.length === 1 ? 'UPDATE' : 'UPDATES'}`;
  const signature = JSON.stringify([run?.id, timeline]);
  $('#results-view-button').title = `${results.length} human-facing ${results.length === 1 ? 'update' : 'updates'}`;
  if (signature === resultsSignature) return;
  resultsSignature = signature;
  const panel = $('#chat-scroll');
  const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 60;
  const position = panel.scrollTop;
  $('#human-feed').replaceChildren(...timeline.map((result) => {
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
  if (!timeline.length && run) $('#human-feed').append(element('p', 'group-empty', 'The team’s human-facing answers will appear here. Follow their conversation in Chat while they work.'));
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
  $('#human-feed').replaceChildren();
  $('#group-feed').replaceChildren();
  groupRows.clear();
  expandedMessages.clear();
  $('#feed').replaceChildren(element('p', 'empty-feed', 'Peer messages and tool activity appear here once the work begins.'));
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
  renderChat(run, agents);
  renderCards(agents, run);
  renderFeed(run, agents);
  renderResults(run);
  renderGroupChat(run);
  if ($('#agent-dialog').open) renderAgentDetails();
  if ($('#election-dialog').open) renderElection();
}
function receiveState(next) {
  const keepSelection = pendingSubmission && pendingSubmission.revision !== navigationRevision && requestedChatId && next.run?.id !== requestedChatId;
  state = { ...state, ...next, ...(keepSelection ? {run: state.run} : {}) };
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
  editingTeam = (configuredTeam || viewedRun()?.agents || defaultTeam()).map((agent) => ({ ...agent }));
  $('#team-count').max = String(maxAgents());
  $('#team-count-limit').textContent = `2–${maxAgents()} agents per swarm`;
  renderTeamEditor();
  $('#team-button').setAttribute('aria-expanded', 'true');
  $('#team-dialog').showModal();
}
function renderTeamEditor() {
  $('#team-count').value = String(editingTeam.length);
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
}
function saveTeam() {
  editingTeam = editingTeam.map((agent) => ({ ...agent, harness: $(`#harness-${CSS.escape(agent.id)}`).value, model: $(`#model-${CSS.escape(agent.id)}`).value.trim(), status: 'queued' }));
  configuredTeam = editingTeam.map((agent) => ({...agent}));
  if (!viewedRun()) render();
}
function applyTeamCount(count = Number($('#team-count').value)) {
  if (!Number.isInteger(count) || count < 2 || count > maxAgents()) {
    toast(`Choose between 2 and ${maxAgents()} agents.`);
    $('#team-count').focus();
    return false;
  }
  saveTeam();
  editingTeam = resizeTeam(editingTeam, count, defaultTeam());
  configuredTeam = editingTeam.map((agent) => ({...agent}));
  renderTeamEditor();
  render();
  return true;
}
function openAddAgents() {
  const run = viewedRun();
  if (run?.status !== 'running') return;
  addTargetId = run.id;
  const remaining = maxAgents() - run.agents.length;
  $('#add-count').max = String(remaining);
  $('#add-count').value = String(Math.min(5, remaining));
  $('#add-count-limit').textContent = `${run.agents.length} agents now · room for ${remaining} more · limit ${maxAgents()}`;
  const options = [element('option', '', 'Mixed harnesses')];
  options[0].value = '';
  for (const capability of state.capabilities || []) {
    if (capability.id === 'claude-code') continue;
    const option = element('option', '', HARNESS_NAMES[capability.id] || capability.name);
    option.value = capability.id;
    option.disabled = capability.available === false;
    options.push(option);
  }
  $('#add-harness').replaceChildren(...options);
  $('#add-model').value = '';
  $('#add-model-label').hidden = true;
  $('#add-agents-dialog').showModal();
  $('#add-count').focus();
}
async function addAgents(event) {
  event.preventDefault();
  const run = viewedRun();
  const count = Number($('#add-count').value);
  if (busy || run?.id !== addTargetId || run.status !== 'running') return;
  if (!Number.isInteger(count) || count < 1 || count > maxAgents() - run.agents.length) {
    toast(`Add between 1 and ${maxAgents() - run.agents.length} agents.`);
    return;
  }
  const harness = $('#add-harness').value;
  const model = $('#add-model').value.trim();
  busy = true;
  $('#add-agents-submit').disabled = true;
  render();
  try {
    await api('/api/agents', {runId: addTargetId, count, ...(harness ? {harness, ...(model ? {model} : {})} : {})});
    $('#add-agents-dialog').close();
    receiveState(await api('/api/state'));
    toast(`${count} ${count === 1 ? 'agent joined' : 'agents joined'} the shared work.`);
  } catch (error) { toast(error.message); }
  finally { busy = false; $('#add-agents-submit').disabled = false; render(); }
}
async function startRun(demo = false, sourceInput = $('#task-input')) {
  const task = sourceInput.value.trim();
  if (!demo && !task) { sourceInput.focus(); return; }
  if (busy) return;
  const revision = navigationRevision;
  const submission = {revision};
  let timeoutSeconds;
  let durationError;
  try { timeoutSeconds = runDuration(); } catch (error) { durationError = error; }
  const toolsEnabled = $('#tools-toggle').checked;
  const target = viewedRun();
  let context = draftMode ? parentRun : target;
  const configured = configuredTeam?.map((agent) => ({...agent}));
  const clearSubmittedText = () => {
    if (revision === navigationRevision && sourceInput.value.trim() === task) sourceInput.value = '';
  };
  busy = true;
  pendingSubmission = submission;
  render();
  try {
    if (!demo && target?.status === 'running') {
      try {
        await api('/api/message', {text: task, runId: target.id});
        clearSubmittedText();
        receiveState(await api('/api/state'));
        return;
      } catch (error) {
        if (error.status !== 409) throw error;
        // The work period can end between a keystroke and the message request.
        // Continue that exact chat, even if the user navigates while awaiting it.
        const finished = await api(`/api/runs/${encodeURIComponent(target.id)}`);
        if (!['complete', 'stopped', 'failed', 'interrupted'].includes(finished.status)) throw error;
        context = finished;
      }
    }
    if (!demo && durationError) throw durationError;
    const team = configured || context?.agents || defaultTeam();
    const agents = team.map(({id, name, role, harness, model}) => ({id, name, role, harness, model}));
    const body = demo ? {demo: true, agents} : {
      task, agents, timeoutSeconds, toolsEnabled,
      ...(context ? {parentId: context.id} : {}),
    };
    const response = await api('/api/run', body);
    if (revision === navigationRevision) {
      historicalRun = null;
      draftMode = false;
      parentRun = null;
      configuredTeam = null;
      selectedId = null;
      clearSubmittedText();
    }
    // A late follow-up must not replace an existing chat the user selected.
    while (revision !== navigationRevision && requestedChatId) {
      const desired = requestedChatId;
      const selectionRevision = navigationRevision;
      await api('/api/select', {id: desired});
      if (selectionRevision === navigationRevision) break;
    }
    if (response.run && revision === navigationRevision) receiveState(response);
    else receiveState(await api('/api/state'));
  } catch (error) { toast(error.message); }
  finally { if (pendingSubmission === submission) pendingSubmission = null; busy = false; render(); }
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
      await selectChat(run.id);
      $('#history-dialog').close();
    });
    return row;
  }));
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text || ''); toast('Copied.'); }
  catch { toast('Your browser could not copy this. You can select and copy the text.'); }
}

$('#run-form').addEventListener('submit', (event) => { event.preventDefault(); startRun(); });
$('#new-chat-button').addEventListener('click', () => newChat());
$('#continue-chat-button').addEventListener('click', () => newChat(true));
$('#return-chat-button').addEventListener('click', () => { requestedChatId = state.run?.id || null; draftMode = false; parentRun = null; render(); });
$('#chat-view-button').addEventListener('click', () => showContent('chat'));
$('#results-view-button').addEventListener('click', () => showContent('results'));
$('#brain-view-button').addEventListener('click', () => setView(true));
$('#agents-view-button').addEventListener('click', () => showInspector(!inspectorOpen));
$('#agent-overview').addEventListener('click', () => showInspector(true));
$('#close-inspector').addEventListener('click', () => showInspector(false));
for (const name of ['list', 'chat']) $(`#agent-${name}-tab`).addEventListener('click', () => {
  $('#agent-list').hidden = name !== 'list';
  $('#agent-conversation').hidden = name !== 'chat';
  $('#agent-list-tab').setAttribute('aria-pressed', String(name === 'list'));
  $('#agent-chat-tab').setAttribute('aria-pressed', String(name === 'chat'));
});
$('#demo-button').addEventListener('click', () => startRun(true));
$('#empty-demo-button').addEventListener('click', () => startRun(true));
$('#team-button').addEventListener('click', openTeam);
$('#apply-team-count').addEventListener('click', () => applyTeamCount());
$('#team-count').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyTeamCount(); } });
$('#team-done').addEventListener('click', () => { if (applyTeamCount()) $('#team-dialog').close(); });
for (const button of document.querySelectorAll('[data-team-step]')) button.addEventListener('click', () => applyTeamCount(editingTeam.length + Number(button.dataset.teamStep)));
for (const button of document.querySelectorAll('[data-add-agents]')) button.addEventListener('click', openAddAgents);
for (const button of document.querySelectorAll('[data-add-count]')) button.addEventListener('click', () => { $('#add-count').value = button.dataset.addCount; });
$('#add-harness').addEventListener('change', () => {
  $('#add-model-label').hidden = !$('#add-harness').value;
  $('#add-model').value = harnessDefaultModel($('#add-harness').value);
});
$('#add-agents-form').addEventListener('submit', addAgents);
$('#reset-team').addEventListener('click', () => { configuredTeam = defaultTeam(); $('#team-dialog').close(); openTeam(); render(); });
$('#team-dialog').addEventListener('close', () => { $('#team-button').setAttribute('aria-expanded', 'false'); updateDurationLabel(); });
$('#agent-dialog').addEventListener('close', () => { selectedId = null; renderCards(displayAgents(), viewedRun()); });
$('#timeout-select').addEventListener('change', updateDurationLabel);
$('#custom-duration').addEventListener('input', updateDurationLabel);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close());
$('#history-button').addEventListener('click', () => { renderHistory(); $('#history-dialog').showModal(); });
$('#back-live').addEventListener('click', () => { historicalRun = null; draftMode = false; parentRun = null; $('#history-dialog').close(); render(); });
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
  try { await api('/api/stop', {runId: viewedRun()?.id}); receiveState(await api('/api/state')); }
  catch (error) { toast(error.message); }
  finally { busy = false; render(); }
});
$('#steering-form').addEventListener('submit', (event) => { event.preventDefault(); startRun(false, $('#steering-input')); });
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
