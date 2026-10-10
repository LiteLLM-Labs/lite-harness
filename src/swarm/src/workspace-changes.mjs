import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute, join, resolve} from 'node:path';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const MAX_FILE = 256 * 1024;
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_ENTRIES = 10000;
const MAX_DIFF = 192 * 1024;
const MAX_REPORT = 1024 * 1024;
const ignored = new Set(['.git', '.swarm', '.changes', '.ssh', '.aws', '.codex', '.agents', '.claude', '.config', '.cache', '.venv', 'venv', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '__pycache__', 'target']);
const privateFile = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx)$/i;
const inFlight = new Map();
const description = 'Observed workspace changes since this work period began. They may include edits by you or other active swarms; they are not attributed to individual agents. Binary, private, generated and oversized files are excluded.';

function locations({workspace, directory, runId}) {
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid run ID.');
  if (typeof workspace !== 'string' || typeof directory !== 'string') throw new Error('A workspace and run directory are required.');
  return {workspace: resolve(workspace), directory: resolve(directory), sidecar: join(resolve(directory), '.changes', runId), runId};
}

function safeRelative(path) {
  return typeof path === 'string' && path.length <= 2048 && path && !isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..' && !ignored.has(part.toLowerCase()) && !privateFile.test(part));
}

async function safeInfo(root, path) {
  if (!safeRelative(path)) return null;
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) return null;
  }
  return lstat(current);
}

async function readText(root, path, remaining) {
  const info = await safeInfo(root, path);
  if (!info?.isFile()) return {reason: 'other'};
  if (info.size > MAX_FILE || info.size > remaining) return {reason: 'size'};
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(Math.min(MAX_FILE, remaining) + 1);
    const {bytesRead} = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_FILE || bytesRead > remaining) return {reason: 'size'};
    const content = bytes.subarray(0, bytesRead);
    if (content.includes(0)) return {reason: 'binary'};
    try {return {text: new TextDecoder('utf-8', {fatal: true}).decode(content), bytes: bytesRead};}
    catch {return {reason: 'binary'};}
  } finally {await file.close();}
}

async function snapshot(settings) {
  const root = await realpath(settings.workspace);
  const stateDirectory = await realpath(settings.directory).catch(() => settings.directory);
  const files = [];
  const known = [];
  const skipped = {binary: 0, size: 0, other: 0};
  let bytes = 0;
  let visited = 0;
  let scanTruncated = false;
  async function walk(path = '') {
    let entries;
    try {entries = await readdir(join(root, path), {withFileTypes: true});}
    catch {skipped.other++; scanTruncated = true; return;}
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) {scanTruncated = true; return;}
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (root === stateDirectory && !path && (entry.name === '.lock' || /^[0-9a-f-]{36}\.json(?:\..*\.tmp)?$/.test(entry.name))) continue;
      if (!safeRelative(name) || join(root, name) === stateDirectory || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {await walk(name); if (visited > MAX_ENTRIES) return; continue;}
      known.push(name);
      if (!entry.isFile()) {skipped.other++; continue;}
      if (files.length >= MAX_FILES || bytes >= MAX_SNAPSHOT) {skipped.size++; continue;}
      try {
        const file = await readText(root, name, MAX_SNAPSHOT - bytes);
        if (file.reason) skipped[file.reason]++;
        else {files.push({path: name, text: file.text}); bytes += file.bytes;}
      } catch {skipped.other++;}
    }
  }
  await walk();
  return {version: 1, workspace: root, capturedAt: Date.now(), files, known, bytes, skipped, scanTruncated, truncated: scanTruncated || skipped.size > 0 || skipped.other > 0};
}

async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {await writeFile(temporary, JSON.stringify(value), {mode: 0o600}); await rename(temporary, path);}
  finally {await rm(temporary, {force: true}).catch(() => {});}
}

async function load(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size > 32 * 1024 * 1024) throw new Error('Saved change snapshot is too large.');
    return JSON.parse(await file.readFile('utf8'));
  } finally {await file.close();}
}

export async function captureRunBaseline(options) {
  const settings = locations(options);
  await mkdir(settings.sidecar, {recursive: true, mode: 0o700});
  const baseline = await snapshot(settings);
  await save(join(settings.sidecar, 'baseline.json'), baseline);
  return {capturedAt: baseline.capturedAt, truncated: baseline.truncated};
}

function clipDiff(text, limit) {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

async function unifiedDiff(settings, path, before, after, limit) {
  const temporary = join(settings.sidecar, `compare-${randomUUID()}`);
  await mkdir(temporary, {mode: 0o700});
  let diff;
  let truncated = false;
  try {
    await Promise.all([writeFile(join(temporary, 'before'), before, {mode: 0o600}), writeFile(join(temporary, 'after'), after, {mode: 0o600})]);
    try {
      const result = await execute('/usr/bin/diff', ['-u', '-L', `a/${path}`, '-L', `b/${path}`, join(temporary, 'before'), join(temporary, 'after')], {timeout: 2000, maxBuffer: MAX_DIFF, env: {PATH: '/usr/bin:/bin', LANG: 'C'}});
      diff = result.stdout;
    } catch (error) {
      if (error.code === 1) diff = error.stdout;
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {diff = error.stdout || ''; truncated = true;}
      else {
        // A full replacement is still an exact diff when the platform has no diff executable.
        const lines = (text, sign) => text ? text.replace(/\n$/, '').split('\n').map((line) => `${sign}${line}`).join('\n') + '\n' + (text.endsWith('\n') ? '' : '\\ No newline at end of file\n') : '';
        const count = (text) => text ? text.replace(/\n$/, '').split('\n').length : 0;
        diff = `--- a/${path}\n+++ b/${path}\n@@ -${before ? 1 : 0},${count(before)} +${after ? 1 : 0},${count(after)} @@\n${lines(before, '-')}${lines(after, '+')}`;
      }
    }
  } finally {await rm(temporary, {recursive: true, force: true});}
  const lines = diff.split('\n');
  const additions = lines.slice(2).filter((line) => line.startsWith('+')).length;
  const deletions = lines.slice(2).filter((line) => line.startsWith('-')).length;
  if (Buffer.byteLength(diff) > limit) {diff = clipDiff(diff, limit); truncated = true;}
  return {diff, additions: truncated ? null : additions, deletions: truncated ? null : deletions, truncated};
}

async function compare(settings) {
  let baseline;
  try {baseline = await load(join(settings.sidecar, 'baseline.json'));}
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {workspace: settings.workspace, runId: settings.runId, available: false, frozen: false, files: [], reason: 'This saved run has no change baseline. New work periods capture changes automatically.', description};
  }
  if (baseline.version !== 1 || !Array.isArray(baseline.files) || !Array.isArray(baseline.known)) throw new Error('Invalid change baseline.');
  const current = await snapshot(settings);
  if (baseline.workspace !== current.workspace) throw new Error('The saved run belongs to a different workspace.');
  const before = new Map(baseline.files.filter((file) => safeRelative(file.path) && typeof file.text === 'string').map((file) => [file.path, file.text]));
  const after = new Map(current.files.map((file) => [file.path, file.text]));
  const knownBefore = new Set(baseline.known);
  const files = [];
  let bytes = 0;
  let truncated = baseline.truncated || current.truncated;
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(path) && (knownBefore.has(path) || baseline.scanTruncated)) continue;
    if (!after.has(path)) {
      try {await safeInfo(current.workspace, path); continue;}
      catch (error) {if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {truncated = true; continue;}}
    }
    const oldText = before.get(path) ?? '';
    const newText = after.get(path) ?? '';
    if (oldText === newText && before.has(path) === after.has(path)) continue;
    if (bytes >= MAX_REPORT) {truncated = true; break;}
    const change = await unifiedDiff(settings, path, oldText, newText, Math.min(MAX_DIFF, MAX_REPORT - bytes));
    files.push({path, status: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified', ...change});
    bytes += Buffer.byteLength(change.diff);
    truncated ||= change.truncated;
  }
  return {workspace: current.workspace, runId: settings.runId, available: true, frozen: false, capturedAt: baseline.capturedAt, comparedAt: current.capturedAt, files, truncated, skipped: current.skipped, description};
}

export async function getRunChanges(options) {
  const settings = locations(options);
  try {return await load(join(settings.sidecar, 'final.json'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (options.finished) return {workspace: settings.workspace, runId: settings.runId, available: false, frozen: false, files: [], reason: 'No final change snapshot was recorded for this saved run.', description};
  if (!inFlight.has(settings.sidecar)) {
    const pending = compare(settings).finally(() => inFlight.delete(settings.sidecar));
    inFlight.set(settings.sidecar, pending);
  }
  return inFlight.get(settings.sidecar);
}

export async function finalizeRunChanges(options) {
  const settings = locations(options);
  try {return await load(join(settings.sidecar, 'final.json'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const report = {...await compare(settings), frozen: true};
  if (report.available) await save(join(settings.sidecar, 'final.json'), report);
  return report;
}
