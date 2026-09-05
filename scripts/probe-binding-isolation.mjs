import { AgentOs } from '@rivet-dev/agentos-core';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
const reports = [];
for (const mode of ['shared-same-names', 'shared-unique-names', 'separate-pools', 'shared-catalog']) {
  const namespaced = mode !== 'shared-same-names';
  const vms = [], invocations = [];
  const makeCollection = label => ({ name: label, description: 'Identity probe', bindings: { read: { description: 'Read identity', inputSchema: z.object({}), execute() { invocations.push(label); return label; } } } });
  const catalog = ['first', 'second'].map(makeCollection);
  try {
    for (const label of ['first', 'second']) {
      const name = namespaced ? label : 'who';
      vms.push(await AgentOs.create({
        ...(mode === 'separate-pools' ? { sidecar: { kind: 'shared', pool: `binding-probe-${label}` } } : {}),
        bindings: mode === 'shared-catalog' ? catalog : [{ ...makeCollection(label), name }],
        permissions: { fs: 'allow', process: 'allow', env: 'allow', network: 'deny', childProcess: 'allow', binding: { default: 'deny', rules: [{ patterns: [`${name}:read`], mode: 'allow' }] } },
      }));
    }
    const calls = [];
    for (let index = 0; index < vms.length; index++) {
      for (const target of namespaced ? ['first', 'second'] : ['who']) {
        const before = invocations.length;
        const result = await vms[index].process.execFile('node', ['-e', `const r=require('child_process').spawnSync('agentos-${target}',['read','--json','{}'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));`], { output: { capture: 'all' } });
        calls.push({ caller: ['first', 'second'][index], target, result, invoked: invocations.slice(before) });
      }
    }
    reports.push({ mode, calls });
  } finally {
    for (const vm of vms) await vm.dispose();
    const sidecars = new Map(vms.map(vm => [vm.sidecar.describe().sidecarId, vm.sidecar]));
    for (const sidecar of sidecars.values()) await sidecar.dispose();
  }
}
function checkIsolation(mode) { return reports.find(r => r.mode === mode).calls.every(call => {
  if (call.result.exitCode !== 0) return false;
  const response = JSON.parse(call.result.stdout);
  if (call.caller !== call.target) return response.status !== 0 && call.invoked.length === 0;
  return response.status === 0 && JSON.parse(response.stdout).result === call.caller && JSON.stringify(call.invoked) === JSON.stringify([call.caller]);
}); }
const separatePoolsIsolationPassed = checkIsolation('separate-pools');
const sharedCatalogIsolationPassed = checkIsolation('shared-catalog');
const report = { recordedAt: new Date().toISOString(), agentos: '0.2.19', separatePoolsIsolationPassed, sharedCatalogIsolationPassed, reports };
await mkdir('artifacts/results', { recursive: true });
await writeFile('artifacts/results/binding-isolation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
// Shared modes are rejected approaches retained as diagnostic controls.
if (!separatePoolsIsolationPassed) process.exitCode = 1;
