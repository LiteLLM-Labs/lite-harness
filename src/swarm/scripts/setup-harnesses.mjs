import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { LOCAL_PI_DIRECTORY, PI_INTEGRITY, PI_PACKAGE, PI_VERSION } from '../src/harness-profiles.mjs';

// Install only inside the ignored local tools directory. No global package or user config changes.
await mkdir(LOCAL_PI_DIRECTORY, { recursive: true });
const allowedEnvironment = new Set(['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key)));
env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH || ''}`;
const npm = process.env.npm_execpath;
const binary = npm ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = [...(npm ? [npm] : []), 'install', '--prefix', LOCAL_PI_DIRECTORY, '--ignore-scripts', '--save-exact', '--no-audit', '--no-fund', `${PI_PACKAGE}@${PI_VERSION}`];
console.log(`Installing Pi ${PI_VERSION} in .swarm/tools/pi…`);
const result = spawnSync(binary, args, { env, stdio: 'inherit', shell: false });
if (result.error) throw new Error(`Could not start npm: ${result.error.code}. Install Node.js 22 or newer first.`);
if (result.status !== 0) process.exit(result.status || 1);
const lock = JSON.parse(await readFile(join(LOCAL_PI_DIRECTORY, 'package-lock.json'), 'utf8'));
const installed = lock.packages?.[`node_modules/${PI_PACKAGE}`];
if (installed?.version !== PI_VERSION || installed?.integrity !== PI_INTEGRITY) throw new Error('Pi package verification failed. The installed version or integrity differs from the pinned release.');
console.log(`Pi ${PI_VERSION} verified. Swarm will discover it automatically. Codex, Claude Code and OpenCode use your installed CLIs.`);
