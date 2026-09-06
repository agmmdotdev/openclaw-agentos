// Enumerate dependencies of this trusted Node installation, never tenant binaries.
// Review the output before using it as a host-acceptance runtime closure.
import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const node = realpathSync(process.execPath);
const output = execFileSync('ldd', [node], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 });
if (output.includes('not found')) throw new Error('Unresolved runtime dependency');
const paths = [node, ...Array.from(output.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm), m => m[1])];
// The loader cache is an explicit file grant, never a grant to /etc.
try { if (statSync('/etc/ld.so.cache').isFile()) paths.push('/etc/ld.so.cache'); } catch {}
const files = [...new Set(paths.map(path => realpathSync(path)))].sort().map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
console.log(JSON.stringify({ version: 1, node, nodeVersion: process.version, reviewRequired: true, files }, null, 2));
