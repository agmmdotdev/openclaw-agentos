// Enumerate dependencies of this trusted Node installation, never tenant binaries.
// Review the output before using it as a host-acceptance runtime closure.
import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const node = realpathSync(process.execPath);
const commands = { node };
for (const arg of process.argv.slice(2)) {
  const match = /^([a-zA-Z0-9_-]+)=(\/.*)$/.exec(arg);
  if (!match || Object.hasOwn(commands, match[1])) throw new Error('Tools must be unique alias=/absolute/trusted/executable arguments');
  commands[match[1]] = realpathSync(match[2]);
}
const paths = Object.values(commands);
for (const executable of Object.values(commands)) {
  const output = execFileSync('ldd', [executable], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 });
  if (output.includes('not found')) throw new Error('Unresolved runtime dependency');
  paths.push(...Array.from(output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm), m => m[1]));
}
// The loader cache is an explicit file grant, never a grant to /etc.
try { if (statSync('/etc/ld.so.cache').isFile()) paths.push('/etc/ld.so.cache'); } catch {}
const files = [...new Set(paths.map(path => realpathSync(path)))].sort().map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
console.log(JSON.stringify({ version: 1, node, nodeVersion: process.version, reviewRequired: true, commands, files }, null, 2));
