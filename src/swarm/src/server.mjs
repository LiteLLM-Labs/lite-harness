import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname, resolve, sep} from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {defaultModel, defaultTeam, validateTeam, HARNESSES, MAX_AGENTS} from './team.mjs';
import {availableHarnesses} from './adapters.mjs';
import {Conversations} from './conversations.mjs';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};

async function readJSON(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  return body;
}

export async function startServer({runner, store, port = 4318, team, capabilities: suppliedCapabilities, token = randomBytes(32).toString('hex')}) {
  const initialTeam = validateTeam(team ?? defaultTeam());
  const clients = new Set();
  const conversations = new Conversations({runner, store});
  const found = suppliedCapabilities ?? await availableHarnesses();
  const capabilities = Array.isArray(found) ? found : Object.entries(found).map(([id, value]) => ({id, name: {native: 'Swarm · LiteLLM', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', pi: 'Pi'}[id], ...value}));
  const state = () => ({
    run: conversations.run,
    runs: conversations.summaries(),
    defaults: {team: initialTeam, maxAgents: MAX_AGENTS, harnessModels: Object.fromEntries(HARNESSES.map((id) => [id, defaultModel(id)])), duration: 600, model: defaultModel('native'), baseUrl: process.env.LITELLM_BASE_URL || 'https://gateway-dev.litellm-sandbox.ai'},
    capabilities,
  });
  const broadcast = () => {
    if (!clients.size) return;
    const payload = `event: state\ndata: ${JSON.stringify(state())}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 1000000) {client.destroy(); clients.delete(client);}
      else client.write(payload);
    }
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, body) => {
      response.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify(body));
    };
    try {
      const currentPort = server.address().port;
      const hosts = [`127.0.0.1:${currentPort}`, `localhost:${currentPort}`];
      if (!hosts.includes(request.headers.host) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, {error: 'Local requests only.'});
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) return json(403, {error: 'Origin does not match this workspace.'});
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/session.js' && request.method === 'GET') {
        if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) return json(403, {error: 'Open this workspace directly.'});
        response.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8'});
        response.end(`globalThis.__SWARM_TOKEN = ${JSON.stringify(token)};`);
        return;
      }
      if (path.startsWith('/api/')) {
        const supplied = Buffer.from(request.headers.authorization || '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, {error: 'Refresh the local view to reconnect.'});
      }
      if (request.method === 'GET' && path === '/api/state') return json(200, state());
      if (request.method === 'GET' && path === '/api/events') {
        response.writeHead(200, {'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-cache'});
        response.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (request.method === 'GET' && path.startsWith('/api/runs/')) {
        const id = path.slice('/api/runs/'.length);
        const run = conversations.getRunner(id)?.run ?? store.get(id);
        return json(run ? 200 : 404, run || {error: 'Run not found.'});
      }
      if (request.method === 'POST') {
        const body = await readJSON(request);
        if (path === '/api/run') {
          return json(201, conversations.start(body));
        }
        if (path === '/api/select') return json(200, conversations.select(body.id));
        if (path === '/api/agents') return json(200, conversations.addAgents(body, body.runId));
        if (path === '/api/message') return json(200, conversations.steer(body.text, body.runId));
        if (path === '/api/stop') return json(200, await conversations.stop(body.runId));
      }
      if (path.startsWith('/api/')) return json(404, {error: 'Endpoint not found.'});
      if (!['GET', 'HEAD'].includes(request.method)) return json(405, {error: 'Method not allowed.'});
      const filePath = resolve(WEB_ROOT, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (!filePath.startsWith(resolve(WEB_ROOT) + sep) || !TYPES[extname(filePath)]) return json(404, {error: 'Not found.'});
      const content = await readFile(filePath);
      response.writeHead(200, {'Content-Type': TYPES[extname(filePath)]});
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) response.end();
      else json(error.statusCode || (error.code === 'ENOENT' ? 404 : 400), {error: String(error.message || error)});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  conversations.on('state', broadcast);
  const heartbeat = setInterval(() => {for (const client of clients) client.write(': heartbeat\n\n');}, 15000);
  heartbeat.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    conversations,
    close: async () => {
      await conversations.close();
      clearInterval(heartbeat);
      conversations.off('state', broadcast);
      for (const client of clients) client.end();
      await new Promise((accept) => server.close(accept));
    },
  };
}
