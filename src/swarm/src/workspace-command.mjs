import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const SANDBOX = '/usr/bin/sandbox-exec';
export const MAX_COMMAND_OUTPUT = 64 * 1024;
export const MAX_COMMAND_TIMEOUT = 120000;

export function commandCapability({networkEnabled = false} = {}) {
  const available = process.platform === 'darwin' && existsSync(SANDBOX);
  return { available, sandbox: available ? 'macOS Seatbelt' : null, network: available && networkEnabled,
    reason: available ? `Local commands can read machine files except protected configuration, and write only the workspace and private temporary files. Outbound network is ${networkEnabled ? 'enabled for authorized tasks' : 'disabled'}.` : 'Shared local commands require macOS sandbox-exec; no unsandboxed fallback is enabled.' };
}

function quote(value) { return JSON.stringify(value); }
function regexEscape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function profile(root, temporary, networkEnabled) {
  const prefix = regexEscape(root) + '/(.*/)?';
  const privatePaths = '/(\\.env($|\\..*)|\\.(ssh|aws|agents|swarm)(/.*)?$)';
  const workspaceConfig = `${prefix}\\.codex(/.*)?$`;
  const gitPaths = `${prefix}\\.git(/.*)?$`;
  const privateHome = ['.codex', '.claude', '.config', '.gnupg', '.npmrc', '.netrc', '.pypirc', '.git-credentials']
    .map(path => join(homedir(), path))
    .map(path => root.startsWith(`${path}/`)
      ? `(require-all (subpath ${quote(path)}) (require-not (subpath ${quote(root)})))`
      : `(subpath ${quote(path)})`);
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
${networkEnabled ? '(allow network-outbound)' : ''}
(allow file-read*)
(allow file-write* (subpath ${quote(root)}) (subpath ${quote(temporary)}) (literal "/dev/null"))
(deny file-read* file-write* (regex ${quote(privatePaths)}) (regex ${quote(workspaceConfig)}) ${privateHome.join(' ')})
(deny file-write* (regex ${quote(gitPaths)}))`;
}

function redact(text, env) {
  for (const [name, value] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) && typeof value === 'string' && value.length >= 8) text = text.split(value).join('[redacted]');
  }
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}

/** A real local command with OS-enforced workspace writes, explicit networking, and no auth environment. */
export async function runWorkspaceCommand({ cwd, command, timeoutMs = 30000, signal, env = process.env, networkEnabled = false }) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 16000) throw new Error('command must be nonempty text of at most 16 KiB.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT) throw new Error('timeoutMs must be an integer from 1 to 120000.');
  if (typeof networkEnabled !== 'boolean') throw new Error('networkEnabled must be a boolean.');
  signal?.throwIfAborted();
  const capability = commandCapability({networkEnabled});
  if (!capability.available) throw new Error(capability.reason);
  const root = await realpath(cwd);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'swarm-command-')));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new Error('Command cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const path = [dirname(process.execPath), ...(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(delimiter)].filter(Boolean);
  const childEnv = { PATH: path.join(delimiter), HOME: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TERM: 'dumb', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  let timer;
  let killTimer;
  let pipeTimer;
  let child;
  let timedOut = false;
  let truncated = false;
  const stdout = [];
  const stderr = [];
  let received = 0;
  let finished = false;
  const kill = signalName => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signalName); } catch { try { child.kill(signalName); } catch {} }
  };
  const forceStop = () => {
    kill('SIGKILL');
    // A deliberately detached daemon can escape the process group and retain
    // inherited pipes. Close our pipe endpoints so it cannot hold this turn open.
    pipeTimer ||= setTimeout(() => {
      if (!finished && (!child.stdout.destroyed || !child.stderr.destroyed)) {
        truncated = true;
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }, 300);
  };
  const terminate = () => {
    if (killTimer || finished) return;
    kill('SIGTERM');
    killTimer = setTimeout(forceStop, 250);
  };
  try {
    controller.signal.throwIfAborted();
    return await new Promise((accept, reject) => {
      child = spawn(SANDBOX, ['-p', profile(root, temporary, networkEnabled), '/bin/sh', '-c', command], {
        cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      controller.signal.addEventListener('abort', terminate, { once: true });
      if (controller.signal.aborted) terminate();
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      const capture = (name, bytes) => {
        const remaining = Math.max(0, MAX_COMMAND_OUTPUT - received);
        const kept = bytes.subarray(0, remaining);
        if (name === 'stdout') stdout.push(kept); else stderr.push(kept);
        received += bytes.length;
        if (received > MAX_COMMAND_OUTPUT) { truncated = true; terminate(); }
      };
      child.stdout.on('data', bytes => capture('stdout', bytes));
      child.stderr.on('data', bytes => capture('stderr', bytes));
      child.once('error', reject);
      // Kill helpers in the same group even if the foreground command exits first.
      child.once('exit', forceStop);
      child.once('close', (exitCode, exitSignal) => {
        if (controller.signal.aborted) reject(controller.signal.reason || new Error('Command cancelled.'));
        else accept({ stdout: redact(new StringDecoder('utf8').write(Buffer.concat(stdout)), env), stderr: redact(new StringDecoder('utf8').write(Buffer.concat(stderr)), env), exitCode, signal: exitSignal,
          timedOut, truncated, sandbox: capability.sandbox, networkEnabled });
      });
    });
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(pipeTimer);
    kill('SIGKILL');
    controller.signal.removeEventListener('abort', terminate);
    signal?.removeEventListener('abort', abort);
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
