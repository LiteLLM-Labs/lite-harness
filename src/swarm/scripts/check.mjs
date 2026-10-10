import {readdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function check(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) check(path);
    else if (/\.(?:mjs|js)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], {stdio: 'inherit'});
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'bin', 'web', 'test', 'scripts']) check(resolve(root, directory));
console.log('All JavaScript syntax checks passed.');
