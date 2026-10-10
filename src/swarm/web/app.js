import { Constellation, layoutAgents } from './assets/constellation.js';

const $ = (selector) => document.querySelector(selector);
const MARKS = { native: 'swarm', codex: 'codex', 'claude-code': 'claude-code', claude: 'claude-code', opencode: 'opencode' };
const HARNESS_NAMES = { native: 'Swarm native', codex: 'Codex', 'claude-code': 'Claude Code', claude: 'Claude Code', opencode: 'OpenCode' };
const ROLES = [
  { id: 'scout', name: 'Scout', role: 'Explore the task and inspect relevant context. Find requirements, evidence, and constraints. Do not modify files.', dependsOn: [] },
  { id: 'builder', name: 'Builder', role: 'Develop the solution. If file writes are enabled, implement the requested deliverable. Otherwise provide a concrete proposal. State what you verified.', dependsOn: [] },
  { id: 'critic', name: 'Critic', role: 'Review the scout and builder contributions. Identify concrete defects, contradictions, and missing evidence. Do not modify files.', dependsOn: ['scout', 'builder'] },
  { id: 'lead', name: 'Lead', role: 'Synthesize the team contributions into the final useful answer. Account for review findings and distinguish completed work from proposals. Do not modify files.', dependsOn: ['scout', 'builder', 'critic'] },
];
let state = { run: null, runs: [], defaults: {}, capabilities: [] };
let selectedId = null;
let historicalRun = null;
let configuredTeam = null;
let busy = false;
let feedSignature = '';
let graphSignature = '';
let lastRunId = null;
let toastTimer;
const field = new Constellation($('#constellation'));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function logo(harness, className = '') {
  const image = element('img', className);
  image.src = `/assets/${MARKS[harness] || 'swarm'}.svg`;
  image.alt = '';
  image.width = 24;
  image.height = 24;
  return image;
}

function defaultTeam() {
  return ROLES.map((role) => ({ ...role, harness: 'native', model: state.defaults.model || '', status: 'queued' }));
}

function viewedRun() {
  return historicalRun || state.run;
}

function displayAgents() {
  return viewedRun()?.agents || configuredTeam || defaultTeam();
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

function shortModel(model, harness) {
  return model || `${HARNESS_NAMES[harness] || harness} default`;
}

function harnessDefaultModel(harness) {
  if (harness === 'native') return state.defaults.model || '';
  return harness === 'claude' ? 'sonnet' : '';
}

function elapsed(start, end = Date.now()) {
  if (!start) return '0s';
  const seconds = Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '0s';
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function eventTime(at, run) {
  return run?.startedAt ? `+${elapsed(run.startedAt, at)}` : '';
}

function stageDescription(agent) {
  if (agent.status === 'running') return agent.activity || 'Working';
  if (agent.status === 'complete') return 'Complete';
  if (agent.status === 'failed') return 'Failed';
  if (agent.status === 'stopped') return 'Stopped';
  return agent.dependsOn?.length ? 'Waiting for context' : 'Ready';
}

function selectAgent(id) {
  selectedId = selectedId === id ? null : id;
  if (selectedId) setTab('conversation');
  feedSignature = '';
  render();
}

function renderGraph(agents, run) {
  const signature = JSON.stringify(agents.map(({ id, name, harness, model, status, activity }) => ({ id, name, harness, model, status, activity }))) + selectedId;
  field.update(agents, selectedId, run?.status === 'running');
  if (signature === graphSignature) return;
  graphSignature = signature;
  const focusedKey = document.activeElement?.dataset.focusKey;
  const fragment = document.createDocumentFragment();
  const hub = element('button', 'hub');
  hub.type = 'button';
  hub.dataset.focusKey = 'hub';
  hub.setAttribute('aria-label', 'Show all agents and the shared conversation');
  hub.append(logo('native'), element('span', 'hub-label', 'SHARED CONTEXT'));
  hub.addEventListener('click', () => { selectedId = null; feedSignature = ''; render(); });
  fragment.append(hub);
  layoutAgents(agents).forEach((agent) => {
    const button = element('button', `agent-node ${agent.status || 'queued'}${selectedId === agent.id ? ' selected' : ''}`);
    button.type = 'button';
    button.dataset.focusKey = `node-${agent.id}`;
    button.style.left = `${agent.x / 19.2}%`;
    button.style.top = `${agent.y / 10.8}%`;
    button.setAttribute('aria-label', `${agent.name}, ${HARNESS_NAMES[agent.harness] || agent.harness}, ${agent.status || 'ready'}. Show conversation.`);
    button.setAttribute('aria-pressed', String(selectedId === agent.id));
    const orb = element('span', 'agent-orb');
    orb.append(logo(agent.harness), element('span', 'orb-status'));
    button.append(orb, element('span', 'agent-node-name', agent.name), element('span', 'agent-node-model', shortModel(agent.model, agent.harness)), element('span', 'agent-node-status', stageDescription(agent)));
    button.addEventListener('click', () => selectAgent(agent.id));
    fragment.append(button);
  });
  $('#graph').replaceChildren(fragment);
  const rows = agents.map((agent) => {
    const row = element('button', `agent-row ${agent.status || 'queued'}${selectedId === agent.id ? ' selected' : ''}`);
    row.type = 'button';
    row.dataset.focusKey = `row-${agent.id}`;
    row.setAttribute('aria-pressed', String(selectedId === agent.id));
    row.setAttribute('aria-label', `Follow ${agent.name}: ${stageDescription(agent)}`);
    const text = element('span', 'agent-text');
    text.append(element('span', 'agent-name', agent.name), element('span', 'agent-meta', HARNESS_NAMES[agent.harness] || agent.harness));
    row.append(logo(agent.harness), text, element('span', 'status-dot'));
    row.addEventListener('click', () => selectAgent(agent.id));
    return row;
  });
  $('#agent-list').replaceChildren(...rows);
  $('#agent-list').style.gridTemplateColumns = agents.length > 4 ? 'repeat(4,minmax(0,1fr))' : '';
  if (focusedKey) document.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
}

function renderStatus(run, agents) {
  const running = run?.status === 'running';
  const currentRunning = state.run?.status === 'running';
  const canSteer = running && !historicalRun && agents.some((agent) => agent.status === 'queued');
  const completed = agents.filter((agent) => agent.status === 'complete').length;
  const active = agents.filter((agent) => agent.status === 'running').length;
  const statusLabels = { running: 'YOUR SWARM IS WORKING', complete: 'THE WORK COMES TOGETHER', failed: 'THIS RUN NEEDS ATTENTION', stopped: 'SWARM STOPPED', interrupted: 'RUN INTERRUPTED' };
  $('#run-state').textContent = historicalRun ? 'FROM YOUR RECENT RUNS' : statusLabels[run?.status] || 'A LITTLE COORDINATION. A LOT OF POSSIBILITY.';
  $('#demo-label').hidden = !run?.demo;
  $('#run-dot').style.background = running ? 'var(--gold)' : run?.status === 'failed' ? '#df9898' : '';
  const headline = $('#headline');
  if (run) {
    headline.classList.add('run-headline');
    headline.textContent = run.task;
    headline.title = run.task;
  } else {
    headline.classList.remove('run-headline');
    headline.replaceChildren(document.createTextNode('One task. '), element('span', '', 'Many minds.'));
    headline.removeAttribute('title');
  }
  const captions = {
    running: `${active} ${active === 1 ? 'mind' : 'minds'} at work. Every conversation, in the open.`,
    complete: 'Different perspectives. One considered answer.',
    failed: 'Read the conversation for details, then start a fresh run.',
    stopped: 'Progress is saved. Your conversations are still here.',
    interrupted: 'This run was interrupted. Its conversation has been preserved.',
  };
  $('#hero-caption').textContent = captions[run?.status] || 'Bring your favorite harnesses. Let them work together.';
  $('#progress-text').textContent = run ? `${completed} of ${agents.length} complete${running ? ` · ${active} working` : ''}` : `${agents.length} agents · 3 stages`;
  $('#elapsed').textContent = run ? `${elapsed(run.startedAt, run.endedAt || Date.now())} ELAPSED` : 'READY WHEN YOU ARE';
  $('#stage-hint').textContent = historicalRun ? 'Viewing a saved run. Use Recent runs to return.' : 'Choose any agent to follow its conversation.';
  $('#stream-label').replaceChildren(element('span', 'status-dot'), document.createTextNode(running ? 'LIVE' : run ? run.status.toUpperCase() : 'STANDING BY'));
  $('#run-button').hidden = currentRunning;
  $('#run-button').disabled = busy;
  $('#stop-button').hidden = !currentRunning;
  $('#stop-button').disabled = busy;
  $('#task-input').disabled = currentRunning;
  $('#demo-button').disabled = currentRunning || busy;
  $('#team-button').disabled = currentRunning;
  $('#steering-input').disabled = !canSteer || busy;
  $('#steering-button').disabled = !canSteer || busy;
  $('#steering-note').textContent = canSteer ? 'Your guidance is shared with agents in the next stage.' : running && !historicalRun ? 'All agents have started. Add new guidance in your next run.' : 'Stay close. Step in whenever you need to.';
  $('#gateway-label').textContent = 'LiteLLM gateway';
  $('#gateway-label').title = state.defaults.baseUrl || 'Gateway configured by your local CLI';
}

// Render a deliberately small safe text subset: model text never becomes HTML.
function richText(container, text) {
  const parts = String(text || '').split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  parts.forEach((part) => {
    if (part.startsWith('`') && part.endsWith('`')) container.append(element('code', '', part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**')) container.append(element('strong', '', part.slice(2, -2)));
    else container.append(document.createTextNode(part));
  });
}

function eventElement(event, agents, run) {
  const agent = agents.find((entry) => entry.id === event.agentId);
  const isUser = event.agentId === 'user' || event.role === 'user' || (!event.agentId && event.type === 'message');
  const card = element('article', `event ${event.type || 'message'}${isUser ? ' user' : ''}`);
  const header = element('div', 'event-header');
  header.append(logo(agent?.harness || 'native'), element('span', 'event-name', agent?.name || (isUser ? 'You' : 'Swarm')));
  if (event.type && event.type !== 'message') header.append(element('span', 'event-type', event.type));
  header.append(element('span', 'event-time', eventTime(event.at, run)));
  const body = element('div', 'event-body');
  richText(body, event.text || '');
  card.append(header, body);
  return card;
}

function renderFeed(run, agents) {
  const selectedAgent = agents.find((agent) => agent.id === selectedId);
  const events = (run?.events || []).filter((event) => !selectedId || event.agentId === selectedId || event.toAgentId === selectedId || !event.agentId || event.agentId === 'user');
  $('#filter-label').textContent = selectedAgent ? `${selectedAgent.name} · ${HARNESS_NAMES[selectedAgent.harness] || selectedAgent.harness}` : 'All agents';
  $('#clear-filter').hidden = !selectedId;
  $('#feed-info').hidden = Boolean(selectedId);
  $('#event-count').textContent = String(events.length);
  const visibleOutputs = selectedAgent ? [selectedAgent] : agents.filter((agent) => agent.status === 'running');
  const signature = JSON.stringify([run?.id, selectedId, events, visibleOutputs.map(({ output, status }) => ({ output, status }))]);
  if (signature === feedSignature) return;
  feedSignature = signature;
  if (!run) return;
  const panel = $('#conversation-panel');
  const shouldStick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 70;
  const scrollPosition = panel.scrollTop;
  const cards = events.map((event) => eventElement(event, agents, run));
  for (const agent of visibleOutputs) {
    if (!agent.output || events.some((event) => event.type === 'message' && event.agentId === agent.id && event.text === agent.output)) continue;
    const output = element('article', 'event agent-output');
    const header = element('div', 'event-header');
    header.append(logo(agent.harness), element('span', 'event-name', agent.name), element('span', 'event-type', agent.status === 'running' ? 'RESPONSE · STREAMING' : 'RESPONSE'));
    const body = element('div', 'event-body');
    richText(body, agent.output);
    output.append(header, body);
    cards.push(output);
  }
  if (!cards.length) {
    const empty = element('div', 'empty-feed');
    empty.append(element('h3', '', selectedAgent ? `${selectedAgent.name} is standing by.` : 'The team is getting started.'), element('p', '', 'Messages will appear here as work begins.'));
    cards.push(empty);
  }
  $('#feed').replaceChildren(...cards);
  panel.scrollTop = shouldStick ? panel.scrollHeight : scrollPosition;
}

function renderResult(run) {
  const result = run?.result || '';
  const container = $('#result-content');
  if (container.dataset.value === result && container.dataset.status === String(run?.status)) return;
  container.dataset.value = result;
  container.dataset.status = String(run?.status);
  container.replaceChildren();
  if (result) {
    container.append(element('h3', '', run.demo ? 'The demo’s final answer.' : 'The team’s final answer.'));
    const body = element('div');
    richText(body, result);
    container.append(body);
  } else {
    container.append(element('h3', '', run?.status === 'running' ? 'A considered answer takes a few minds.' : 'Your result will appear here.'), element('p', '', 'The lead combines the team’s work after the review stage. Individual responses are available in each agent’s conversation.'));
  }
  $('#copy-result').hidden = !result;
  $('#result-mark').hidden = !result;
}

function render() {
  const run = viewedRun();
  const agents = displayAgents();
  if (run?.id !== lastRunId) {
    lastRunId = run?.id;
    selectedId = null;
    feedSignature = '';
    graphSignature = '';
  }
  renderStatus(run, agents);
  renderGraph(agents, run);
  renderFeed(run, agents);
  renderResult(run);
}

function receiveState(next) {
  state = { ...state, ...next };
  render();
}

function setTab(name) {
  const showConversation = name === 'conversation';
  for (const tabName of ['conversation', 'result']) {
    const active = name === tabName;
    $(`#${tabName}-tab`).setAttribute('aria-selected', String(active));
    $(`#${tabName}-tab`).tabIndex = active ? 0 : -1;
    $(`#${tabName}-panel`).hidden = !active;
  }
  $('#agent-filter').hidden = !showConversation;
}

function openTeam() {
  const team = configuredTeam || defaultTeam();
  const capabilityMap = new Map((state.capabilities || []).map((capability) => [capability.id, capability]));
  $('#team-editor').replaceChildren(...team.map((agent, index) => {
    const row = element('div', 'team-config-row');
    const name = element('span', 'team-role', agent.name);
    name.append(element('small', '', ['Explore', 'Create', 'Review', 'Synthesize'][index] || 'Contribute'));
    const harnessLabel = element('label', '', 'Harness');
    const select = element('select');
    select.id = `harness-${agent.id}`;
    select.setAttribute('aria-label', `${agent.name} harness`);
    for (const id of ['native', 'codex', 'claude']) {
      const capability = capabilityMap.get(id);
      const option = element('option', '', `${HARNESS_NAMES[id]}${capability?.available === false ? ' · unavailable' : ''}`);
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
    select.addEventListener('change', () => {
      model.value = harnessDefaultModel(select.value);
      saveTeam();
    });
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
  configuredTeam = ROLES.map((role) => ({ ...role, harness: $(`#harness-${role.id}`).value, model: $(`#model-${role.id}`).value.trim(), status: 'queued' }));
  if (!viewedRun()) render();
}

async function startRun(demo = false) {
  const task = $('#task-input').value.trim();
  if (!demo && !task) { $('#task-input').focus(); return; }
  if (busy || state.run?.status === 'running') return;
  busy = true;
  render();
  try {
    const body = demo ? { demo: true, task: 'Design a faster onboarding flow for a developer tool.' } : {
      task,
      agents: (configuredTeam || defaultTeam()).map(({ status, ...agent }) => agent),
      timeoutSeconds: Number($('#timeout-select').value),
      toolsEnabled: $('#tools-toggle').checked,
    };
    const response = await api('/api/run', body);
    historicalRun = null;
    selectedId = null;
    setTab('conversation');
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
    metadata.append(element('span', '', run.status), element('span', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
    row.append(element('span', 'history-title', run.task || 'Untitled run'), metadata);
    row.addEventListener('click', async () => {
      try {
        const result = await api(`/api/runs/${encodeURIComponent(run.id)}`);
        historicalRun = result.run || result;
        selectedId = null;
        $('#history-dialog').close();
        setTab('conversation');
        render();
      } catch (error) { toast(error.message); }
    });
    return row;
  }));
}

$('#run-form').addEventListener('submit', (event) => { event.preventDefault(); startRun(); });
$('#demo-button').addEventListener('click', () => startRun(true));
$('#empty-demo-button').addEventListener('click', () => startRun(true));
$('#team-button').addEventListener('click', openTeam);
$('#reset-team').addEventListener('click', () => { configuredTeam = null; $('#team-dialog').close(); openTeam(); render(); });
$('#team-dialog').addEventListener('close', () => { $('#team-button').setAttribute('aria-expanded', 'false'); });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#history-button').addEventListener('click', () => { renderHistory(); $('#history-dialog').showModal(); });
$('#back-live').addEventListener('click', () => { historicalRun = null; selectedId = null; $('#history-dialog').close(); render(); });
$('#clear-filter').addEventListener('click', () => { selectedId = null; feedSignature = ''; render(); });
$('#conversation-tab').addEventListener('click', () => setTab('conversation'));
$('#result-tab').addEventListener('click', () => setTab('result'));
$('.view-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const next = $('#conversation-tab').getAttribute('aria-selected') === 'true' ? 'result' : 'conversation';
  setTab(next);
  $(`#${next}-tab`).focus();
});
$('#copy-result').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(viewedRun()?.result || ''); toast('Result copied.'); }
  catch { toast('Your browser could not copy the result. You can select and copy the text.'); }
});
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
    toast('Guidance shared for the next stage.');
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
    const response = await fetch('/api/events', {
      headers: { Authorization: `Bearer ${globalThis.__SWARM_TOKEN}` },
      signal: streamController.signal,
    });
    if (response.status === 401 || response.status === 403) {
      connectionStatus(false);
      toast('The local session changed. Reload this page to reconnect.');
      return;
    }
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
    if (pageClosing || error.name === 'AbortError') return;
  }
  if (pageClosing) return;
  connectionStatus(false);
  streamRetryTimer = setTimeout(connectUpdates, streamRetryDelay);
  streamRetryDelay = Math.min(streamRetryDelay * 2, 30000);
}

window.addEventListener('pagehide', () => {
  pageClosing = true;
  clearTimeout(streamRetryTimer);
  streamController?.abort();
});
render();
api('/api/state').then(receiveState).catch((error) => toast(`Cannot connect to the local swarm: ${error.message}`));
connectUpdates();
setInterval(() => {
  const run = viewedRun();
  if (run?.status === 'running') $('#elapsed').textContent = `${elapsed(run.startedAt)} ELAPSED`;
}, 1000);
