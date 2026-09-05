import { AgentOs } from '@rivet-dev/agentos-core';
import { readFile, readdir, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeLargeFile } from '../../dist/src/write-large-file.js';
import { OPENCLAW_AGENTOS_NODE_BUILTINS } from '../../dist/src/compatibility.js';
import { createHostSqlite } from '../../src/host-sqlite.mjs';

const instances = Number(process.argv[2] ?? 1);
if (![1, 2, 4].includes(instances)) throw new Error('Expected 1, 2 or 4 instances');
const start = performance.now(), resources = [];
const root = await mkdtemp(join(tmpdir(), 'openclaw-bench-'));
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now() - start, ...data })); }
const settle = () => new Promise(resolve => setTimeout(resolve, 600));
try {
  mark('baseline', { placement: 'one-sidecar-pool-per-vm' }); await settle();
  for (let index = 0; index < instances; index++) {
    const directory = join(root, String(index)); await mkdir(directory);
    const sqlite = createHostSqlite(join(directory, 'databases'));
    let hostSqlMilliseconds = 0;
    const executeSql = sqlite.collection.bindings.call.execute;
    sqlite.collection.bindings.call.execute = request => {
      const started = performance.now();
      try { return executeSql(request); }
      finally { hostSqlMilliseconds += performance.now() - started; }
    };
    const entry = { index, sqlite }; resources.push(entry);
    const options = {
      // A shared sidecar replaces its host binding handler on VM creation.
      // Separate pools preserve the instance's binding closure; no containers.
      sidecar: { kind: 'shared', pool: `core-benchmark-${randomUUID()}` },
      mounts: ['workspace', 'state'].map(name => ({ path: `/${name}`, plugin: { id: 'chunked_local', config: { metadataPath: join(directory, `${name}.sqlite`), blockRoot: join(directory, `${name}-blocks`), uid: 1000, gid: 1000, dirMode: 0o700, fileMode: 0o600 } } })),
      bindings: [sqlite.collection, { name: 'bench', description: 'Benchmark checkpoints', bindings: { mark: { description: 'Record a checkpoint', inputSchema: z.object({ label: z.string(), data: z.string() }), execute({ label, data }) { mark(label, { instance: index, sqliteCalls: sqlite.stats.calls, hostSqlMilliseconds, ...JSON.parse(data) }); return 'ok'; } } } }],
      allowedNodeBuiltins: [...OPENCLAW_AGENTOS_NODE_BUILTINS, 'querystring', 'console', 'sqlite', 'stream/web', 'constants', 'inspector'],
      permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', env: 'allow', network: 'deny', binding: { default: 'deny', rules: [{ patterns: ['core-sqlite:call', 'bench:mark'], mode: 'allow' }] } },
      limits: { resources: { maxProcesses: 32, maxOpenFds: 256, maxFilesystemBytes: 512 * 1024 * 1024 }, process: { pendingStdinBytes: 64 * 1024 * 1024, pendingEventBytes: 64 * 1024 * 1024, pendingEventCount: 10000 }, jsRuntime: { v8HeapLimitMb: 256, cpuTimeLimitMs: 120000, wallClockLimitMs: 180000 } },
    };
    mark('provision:start', { instance: index });
    const setup = await AgentOs.create({ ...options, user: { uid: 0, gid: 0 } });
    try {
      const result = await setup.process.execFile('node', ['-e', "const fs=require('fs');for(const p of ['/workspace','/state']){fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)}"], { output: { capture: 'all' } });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    } finally { await setup.dispose(); }
    entry.vm = await AgentOs.create(options);
    mark('provision:end', { instance: index });
  }
  mark('empty-vms'); await settle();
  for (const { vm, index } of resources) {
    mark('stage:start', { instance: index });
    await writeLargeFile(vm, '/core/benchmark.mjs', await readFile('artifacts/core/benchmark.mjs'));
    await vm.filesystem.mkdir('/core/compat', { recursive: true });
    for (const name of await readdir('artifacts/core/compat')) {
      let content = await readFile(`artifacts/core/compat/${name}`, 'utf8');
      if (name === 'sqlite.mjs') {
        const anchor = 'function call(request) {';
        if (content.split(anchor).length !== 2) throw new Error('SQLite benchmark instrumentation boundary changed');
        content = content.replace(anchor, 'function benchmarkRawCall(request) {') + `
let benchmarkSqlCalls = 0, benchmarkSqlMilliseconds = 0;
function call(request) {
  const start = performance.now(); benchmarkSqlCalls++;
  try { return benchmarkRawCall(request); }
  finally { benchmarkSqlMilliseconds += performance.now() - start; }
}
export function getBenchmarkSqlTiming() { return { calls: benchmarkSqlCalls, milliseconds: benchmarkSqlMilliseconds }; }
`;
      }
      await vm.filesystem.writeFile(`/core/compat/${name}`, content);
    }
    const packageRequire = createRequire(await realpath('node_modules/openclaw/package.json'));
    await vm.filesystem.writeFile('/core/web-tree-sitter.wasm', await readFile(join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')));
    await vm.filesystem.mkdir('/core/node_modules/tree-sitter-bash', { recursive: true });
    await vm.filesystem.writeFile('/core/node_modules/tree-sitter-bash/package.json', JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
    await vm.filesystem.writeFile('/core/node_modules/tree-sitter-bash/tree-sitter-bash.wasm', await readFile(packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));
    mark('stage:end', { instance: index });
  }
  mark('staged'); await settle();
  mark('launch:start');
  const results = await Promise.all(resources.map(async ({ vm, index, sqlite }) => {
    const result = await vm.process.execFile('node', ['/core/benchmark.mjs', '--internal-worker-prewarm'], { env: { OPENCLAW_STATE_DIR: '/state/openclaw', OPENCLAW_CHILD_OOM_SCORE_ADJ: '0', BENCH_WARM_TURNS: '5', BENCH_SPLIT_INIT: process.env.BENCH_SPLIT_INIT ?? '0' }, timeoutMs: 180000, output: { capture: 'all' } });
    mark('process:end', { instance: index, result, sqlite: sqlite.stats });
    return result;
  }));
  mark('processes-exited'); await settle();
  if (results.some(result => result.exitCode !== 0 || result.outcome !== 'succeeded')) throw new Error('A benchmark workload failed');
} catch (error) { mark('error', { message: error.stack }); process.exitCode = 1; }
finally {
  mark('dispose:start');
  for (const { vm, sqlite } of resources) { await vm?.dispose(); sqlite.dispose(); }
  mark('disposed'); await settle();
  if (global.gc) { global.gc(); mark('disposed-host-gc'); await settle(); }
  mark('sidecars-dispose:start');
  for (const { vm } of resources) await vm?.sidecar.dispose();
  mark('sidecars-disposed'); await settle();
  await rm(root, { recursive: true, force: true });
  mark('done');
}
