import { AgentOs, createHostDirBackend } from '@rivet-dev/agentos-core';
import { readFile, readdir, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeLargeFile } from '../../dist/src/write-large-file.js';
import { OPENCLAW_AGENTOS_NODE_BUILTINS } from '../../dist/src/compatibility.js';
import { decode as decodeSqlRequest } from '../../src/host-sqlite.mjs';
import { createCoreHostSqlite } from '../../src/core-host-sqlite.mjs';
import { createCoreArtifactStore } from '../../src/core-artifact-store.mjs';

const coreMount = process.env.BENCH_CORE_MOUNT ?? 'upload';
// Diagnostic only: host_dir did not enforce maxFilesystemBytes in the probe.
const dataMount = process.env.BENCH_DATA_MOUNT ?? 'chunked_local';
if (!['chunked_local', 'host_dir'].includes(dataMount)) throw new Error('Unknown BENCH_DATA_MOUNT');
if (!['upload', 'host_dir'].includes(coreMount)) throw new Error('Unknown BENCH_CORE_MOUNT');
if (process.env.BENCH_SQL_SCHEMA_MODE && !['individual', 'table-only', 'table-index'].includes(process.env.BENCH_SQL_SCHEMA_MODE)) throw new Error('Unknown BENCH_SQL_SCHEMA_MODE');
const canonicalBatching = process.env.BENCH_CANONICAL_BATCHING === '1' && !process.env.BENCH_SQL_SCHEMA_MODE;
const warmTurns = Number(process.env.BENCH_WARM_TURNS ?? 5);
const idleMs = Number(process.env.BENCH_IDLE_MS ?? 1500);
if (!Number.isSafeInteger(idleMs) || idleMs < 1500 || idleMs > 60000) throw new Error('BENCH_IDLE_MS must be between 1500 and 60000');
if (!Number.isSafeInteger(warmTurns) || warmTurns < 1 || warmTurns > 100) throw new Error('BENCH_WARM_TURNS must be between 1 and 100');
const heapMb = Number(process.env.CORE_HEAP_MB ?? 256);
const wasmHeapMb = process.env.CORE_WASM_HEAP_MB ? Number(process.env.CORE_WASM_HEAP_MB) : undefined;
for (const value of [heapMb, wasmHeapMb].filter(value => value !== undefined)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Heap limits must be positive integers');
const instances = Number(process.argv[2] ?? 1);
if (![1, 2, 4].includes(instances)) throw new Error('Expected 1, 2 or 4 instances');
const start = performance.now(), resources = [];
let artifactStore;
const root = await mkdtemp(join(tmpdir(), 'openclaw-bench-'));
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now() - start, ...data })); }
const settle = () => new Promise(resolve => setTimeout(resolve, 600));
try {
  mark('baseline', { placement: 'one-sidecar-pool-per-vm', coreMount, dataMount, canonicalBatching }); await settle();
  if (coreMount === 'host_dir') artifactStore = await createCoreArtifactStore();
  for (let index = 0; index < instances; index++) {
    const directory = join(root, String(index)); await mkdir(directory);
    const dataMounts = [];
    for (const name of ['workspace', 'state']) {
      if (dataMount === 'host_dir') {
        const hostPath = join(directory, name);
        await mkdir(hostPath, { mode: 0o777 });
        dataMounts.push({ path: `/${name}`, plugin: createHostDirBackend({ hostPath, readOnly: false }) });
      } else dataMounts.push({ path: `/${name}`, plugin: { id: 'chunked_local', config: { metadataPath: join(directory, `${name}.sqlite`), blockRoot: join(directory, `${name}-blocks`), uid: 1000, gid: 1000, dirMode: 0o700, fileMode: 0o600 } } });
    }
    const sqlite = await createCoreHostSqlite(join(directory, 'databases'), { statementCacheSize: Number(process.env.BENCH_SQL_STATEMENT_CACHE ?? 0) });
    let hostSqlMilliseconds = 0;
    const executeSql = sqlite.collection.bindings.call.execute;
    sqlite.collection.bindings.call.execute = request => {
      const started = performance.now();
      if (process.env.BENCH_PROFILE_SQL === '1') {
        const decoded = decodeSqlRequest(JSON.parse(request.payload));
        const key = decoded.op + ':' + (decoded.sql ?? '').replace(/\s+/g, ' ').trim();
        const profile = sqlite.stats.profile ??= {};
        profile[key] = (profile[key] ?? 0) + 1;
      }
      try { return executeSql(request); }
      finally { hostSqlMilliseconds += performance.now() - started; }
    };
    const entry = { index, sqlite }; resources.push(entry);
    const options = {
      // A shared sidecar replaces its host binding handler on VM creation.
      // Separate pools preserve the instance's binding closure; no containers.
      sidecar: { kind: 'shared', pool: `core-benchmark-${randomUUID()}` },
      mounts: dataMounts,
      bindings: [sqlite.collection, { name: 'bench', description: 'Benchmark checkpoints', bindings: { mark: { description: 'Record a checkpoint', inputSchema: z.object({ label: z.string(), data: z.string() }), execute({ label, data }) { mark(label, { instance: index, sqliteCalls: sqlite.stats.calls, hostSqlMilliseconds, ...JSON.parse(data) }); return 'ok'; } } } }],
      allowedNodeBuiltins: [...OPENCLAW_AGENTOS_NODE_BUILTINS, 'querystring', 'console', 'sqlite', 'stream/web', 'constants', 'inspector'],
      permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', env: 'allow', network: 'deny', binding: { default: 'deny', rules: [{ patterns: ['core-sqlite:call', 'bench:mark'], mode: 'allow' }] } },
      limits: { ...(wasmHeapMb ? { wasm: { runnerHeapLimitMb: wasmHeapMb } } : {}), resources: { maxProcesses: 32, maxOpenFds: 256, maxFilesystemBytes: 512 * 1024 * 1024 }, process: { pendingStdinBytes: 64 * 1024 * 1024, pendingEventBytes: 64 * 1024 * 1024, pendingEventCount: 10000 }, jsRuntime: { v8HeapLimitMb: heapMb, cpuTimeLimitMs: 120000, wallClockLimitMs: 180000 } },
    };
    if (artifactStore) options.mounts.push(artifactStore.mount);
    mark('provision:start', { instance: index });
    const setup = await AgentOs.create({ ...options, user: { uid: 0, gid: 0 } });
    try {
      const result = await setup.process.execFile('node', ['-e', dataMount === 'host_dir'
        ? "const fs=require('fs');for(const p of ['/workspace','/state'])fs.chmodSync(p,0o777)"
        : "const fs=require('fs');for(const p of ['/workspace','/state']){fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)}"], { output: { capture: 'all' } });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    } finally { await setup.dispose(); }
    entry.vm = await AgentOs.create(options);
    mark('provision:end', { instance: index });
  }
  mark('empty-vms'); await settle();
  for (const { vm, index } of resources) {
    mark('stage:start', { instance: index });
    if (artifactStore && index > 0) { mark('stage:end', { instance: index, reusedArtifactStore: true }); continue; }
    const stageFs = artifactStore?.filesystem ?? vm.filesystem;
    if (coreMount === 'host_dir') await stageFs.copyFile('artifacts/core/benchmark.mjs', '/core/benchmark.mjs');
    else await writeLargeFile(vm, '/core/benchmark.mjs', await readFile('artifacts/core/benchmark.mjs'));
    await stageFs.mkdir('/core/compat', { recursive: true });
    for (const name of await readdir('artifacts/core/compat')) {
      let content = await readFile(`artifacts/core/compat/${name}`, 'utf8');
      if (name === 'sqlite.mjs') {
        if (!canonicalBatching) {
          const method = 'collectOpenClawCanonicalStrictTables()';
          if (content.split(method).length !== 2) throw new Error('Canonical batching control boundary changed');
          content = content.replace(method, '__disabledCollectOpenClawCanonicalStrictTables()');
        }
        if (['individual', 'table-only'].includes(process.env.BENCH_SQL_SCHEMA_MODE)) {
          const method = 'collectOpenClawNamedIndexContract(indexName)';
          if (content.split(method).length !== 2) throw new Error('Named index batching control boundary changed');
          content = content.replace(method, '__disabledCollectOpenClawNamedIndexContract(indexName)');
        }
        if (process.env.BENCH_SQL_SCHEMA_MODE === 'individual') {
          const batchMethod = 'collectOpenClawTableContract(tableName)';
          if (content.split(batchMethod).length !== 2) throw new Error('Schema batching control boundary changed');
          content = content.replace(batchMethod, '__disabledCollectOpenClawTableContract(tableName)');
        }
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
      if (name === 'child-process.mjs' && process.env.BENCH_PROFILE_PROCESS === '1') {
        content += `
const benchmarkNativeSpawn = childProcess.spawn;
let benchmarkProcessId = 0;
export function spawn(...args) {
  const id = ++benchmarkProcessId, start = performance.now();
  const child = Reflect.apply(benchmarkNativeSpawn, childProcess, args);
  for (const event of ['spawn', 'exit', 'close', 'error']) child.once(event, (code, signal) => {
    console.error('PROCESS_PROFILE=' + JSON.stringify({ id, file: args[0], event, elapsedMs: performance.now() - start, code: typeof code === 'number' ? code : undefined, signal }));
  });
  return child;
}
childProcess.spawn = spawn;
`;
      }
      if (name === 'fs.mjs' && process.env.BENCH_PROFILE_FS === '1') {
        content += `
const benchmarkFsTiming = {};
function benchmarkWrapFs(object, key, promise) {
 const original = object[key];
 if (typeof original !== 'function') return;
 object[key] = function (...args) {
  const entry = benchmarkFsTiming[(promise ? 'promises.' : '') + key] ??= { calls: 0, milliseconds: 0 };
  entry.calls++; const start = performance.now();
  const end = () => { entry.milliseconds += performance.now() - start; };
  try { const result = Reflect.apply(original, this, args); if (promise) return result.then(value => { end(); return value; }, error => { end(); throw error; }); end(); return result; }
  catch(error) { end(); throw error; }
 };
}
for (const key of Object.keys(fs)) if (key.endsWith('Sync')) benchmarkWrapFs(fs, key, false);
for (const key of Object.keys(fs.promises)) benchmarkWrapFs(fs.promises, key, true);
globalThis.__benchmarkFsTiming = () => benchmarkFsTiming;
`;
      }
      await stageFs.writeFile(`/core/compat/${name}`, content);
    }
    const packageRequire = createRequire(await realpath('node_modules/openclaw/package.json'));
    await stageFs.writeFile('/core/web-tree-sitter.wasm', await readFile(join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')));
    await stageFs.mkdir('/core/node_modules/tree-sitter-bash', { recursive: true });
    await stageFs.writeFile('/core/node_modules/tree-sitter-bash/package.json', JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
    await stageFs.writeFile('/core/node_modules/tree-sitter-bash/tree-sitter-bash.wasm', await readFile(packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));
    artifactStore?.seal();
    mark('stage:end', { instance: index });
  }
  mark('staged'); await settle();
  mark('launch:start');
  const results = await Promise.all(resources.map(async ({ vm, index, sqlite }) => {
    const result = await vm.process.execFile('node', ['/core/benchmark.mjs', '--internal-worker-prewarm'], { env: { OPENCLAW_STATE_DIR: '/state/openclaw', OPENCLAW_CHILD_OOM_SCORE_ADJ: '0', BENCH_WORKLOAD: process.env.BENCH_WORKLOAD ?? 'core-shell', BENCH_REVERSE: process.env.BENCH_REVERSE ?? '0', BENCH_WARM_TURNS: String(warmTurns), BENCH_IDLE_MS: String(idleMs), BENCH_SPLIT_INIT: process.env.BENCH_SPLIT_INIT ?? '0', BENCH_PROFILE_CORE: process.env.BENCH_PROFILE_CORE ?? '0' }, timeoutMs: 180000, output: { capture: 'all' } });
    mark('process:end', { instance: index, result, sqlite: sqlite.stats });
    if (/failed to asynchronously prepare wasm|Aborted\(Error:.*\/core\//.test(result.stderr ?? '')) throw new Error('Core parser asset failed to load');
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
  await artifactStore?.dispose();
  await rm(root, { recursive: true, force: true });
  mark('done');
}
