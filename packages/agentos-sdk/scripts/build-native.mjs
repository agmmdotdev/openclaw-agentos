import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });
for (const [source, output] of [
  ['preflight', 'linux-preflight'], ['file-access', 'linux-file-access'],
  ['launcher', 'linux-launcher-experimental'],
  ['supervisor', 'linux-supervisor-experimental'],
]) {
  const result = spawnSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror',
    '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', `native/${source}.c`,
    '-Wl,-z,relro,-z,now', '-o', `dist/${output}`], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
