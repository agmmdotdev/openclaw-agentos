import { AgentOs } from '@rivet-dev/agentos-core';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

// Instrumented diagnosis only. These timings are not core-flow benchmarks.
const vm = await AgentOs.create({
  sidecar: { kind: 'shared', pool: `shell-startup-${randomUUID()}` },
  permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', network: 'deny' },
});
const runs = [];
try {
  await vm.filesystem.writeFile('/tmp/phase-seed', 'phase-seed\n');
  for (const [name, command, args] of [
    ['shell-builtin', '/bin/sh', ['-c', "printf 'phase-seed\\n'"]],
    ['direct-cat', 'cat', ['/tmp/phase-seed']],
    ['shell-cat', '/bin/sh', ['-c', 'cat /tmp/phase-seed']],
  ]) {
    for (let iteration = 0; iteration < 6; iteration++) {
      const started = performance.now();
      const result = await vm.process.execFile(command, args, {
        env: { AGENTOS_WASM_WARMUP_DEBUG: '1' }, output: { capture: 'all' },
      });
      const elapsedMs = performance.now() - started;
      const lines = result.stderr.split('\n').filter(Boolean);
      if (result.exitCode !== 0 || result.stdout !== 'phase-seed\n' || lines.some(line => !line.startsWith('__AGENTOS_WASM_'))) throw new Error(JSON.stringify(result));
      const metrics = lines.map(line => ({ kind: line.slice(0, line.indexOf(':')), ...JSON.parse(line.slice(line.indexOf(':') + 1)) }));
      if (!metrics.some(metric => metric.kind === '__AGENTOS_WASM_PHASE_METRICS__')) throw new Error('WASM phase diagnostics missing');
      runs.push({ name, iteration, elapsedMs, metrics });
    }
  }
  await mkdir('artifacts/results', { recursive: true });
  await writeFile('artifacts/results/shell-startup-phases.json', JSON.stringify({
    agentos: '0.2.19', node: process.version, instrumented: true,
    environment: Object.fromEntries(['AGENTOS_V8_WARM_ISOLATES', 'MALLOC_ARENA_MAX', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_MMAP_THRESHOLD_'].map(key => [key, process.env[key] ?? null])),
    runs,
  }, null, 2) + '\n');
  console.log('Recorded shell startup phases for 18 checked commands.');
} finally { await vm.dispose(); await vm.sidecar.dispose(); }
