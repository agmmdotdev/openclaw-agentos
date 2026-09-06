import { AgentOs } from '@rivet-dev/agentos-core';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { writeLargeFile } from '../dist/src/write-large-file.js';
import { OPENCLAW_AGENTOS_NODE_BUILTINS } from '../dist/src/compatibility.js';
import { createCoreHostSqlite } from '../src/core-host-sqlite.mjs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { compileFixture } from './compile-async.mjs';
import { createCoreArtifactStore } from '../src/core-artifact-store.mjs';

const artifactMode = process.env.CORE_ARTIFACT_MODE ?? 'host_dir';
if (!['upload', 'host_dir'].includes(artifactMode)) throw new Error('Unknown CORE_ARTIFACT_MODE');
let artifactStore;
const sqliteRoot = await mkdtemp(join(tmpdir(), 'openclaw-agentos-sqlite-'));
await mkdir(join(sqliteRoot, 'databases'));
const statementCacheSize = Number(process.env.CORE_SQL_STATEMENT_CACHE ?? 0);
const sqlite = await createCoreHostSqlite(join(sqliteRoot, 'databases'), { statementCacheSize });
const options = {
  // Concurrent VMs with different bindings cannot share agentOS 0.2.19's host
  // callback handler. Retain this pool across recreation of this one tenant.
  sidecar: { kind: 'shared', pool: `openclaw-core-${randomUUID()}` },
  mounts: ['workspace', 'state'].map(name => ({ path: `/${name}`, plugin: { id: 'chunked_local', config: { metadataPath: join(sqliteRoot, `${name}.sqlite`), blockRoot: join(sqliteRoot, `${name}-blocks`), uid: 1000, gid: 1000, dirMode: 0o700, fileMode: 0o600 } } })),
  bindings: [sqlite.collection],
  allowedNodeBuiltins: [...OPENCLAW_AGENTOS_NODE_BUILTINS, 'querystring', 'console', 'sqlite', 'stream/web', 'constants', 'inspector'],
  permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', env: 'allow', network: 'deny', binding: { default: 'deny', rules: [{ patterns: ['core-sqlite:call'], mode: 'allow' }] } },
  limits: {
    resources: { maxProcesses: 32, maxOpenFds: 256, maxFilesystemBytes: 512 * 1024 * 1024 },
    process: { pendingStdinBytes: 64 * 1024 * 1024, pendingEventBytes: 64 * 1024 * 1024, pendingEventCount: 10000 },
    jsRuntime: { v8HeapLimitMb: 256, cpuTimeLimitMs: 60000, wallClockLimitMs: 90000 },
  },
};
let vm;
const reports = [];
const reportPath = process.env.CORE_PROBE_REPORT ?? (statementCacheSize ? `artifacts/results/core-probe-statement-cache-${statementCacheSize}.json` : 'artifacts/results/core-probe.json');
let completed = false;
try {
  if (artifactMode === 'host_dir') { artifactStore = await createCoreArtifactStore(); options.mounts.push(artifactStore.mount); }
  async function stage() {
    const stageFs = artifactStore?.filesystem ?? vm.filesystem;
    const fixture = await readFile('test/fixtures/core-turn.mjs', 'utf8');
    const failures = await readFile('test/fixtures/core-failures.mjs', 'utf8');
    const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
    const profileFixture = manifest.profile === 'core' ? await readFile('test/fixtures/core-profile.mjs', 'utf8') : '';
    // Execute a streamed entry in both modes, preserving the runtime's large
    // entry path instead of loading the worker as a capped dependency response.
    const runner = await compileFixture('\nfor (const coreProbePhase of (process.env.CORE_PHASES ?? \'tools\').split(\',\')) { await (async () => {\n' + fixture + '\n})(); }\nif (process.env.CORE_FAILURES === \'1\') { await (async () => {\n' + failures + '\n})(); }\n' + profileFixture);
    if (artifactStore) await stageFs.writeEntry('artifacts/core/worker.mjs', '/core/probe.mjs', '\n' + runner, manifest.outputSha256);
    else {
      const worker = await readFile('artifacts/core/worker.mjs');
      if (createHash('sha256').update(worker).digest('hex') !== manifest.outputSha256) throw new Error('Unverified core worker artifact');
      await writeLargeFile(vm, '/core/probe.mjs', Buffer.concat([worker, Buffer.from('\n' + runner)]));
    }
    await stageFs.mkdir('/core/compat', { recursive: true });
    for (const name of await readdir('artifacts/core/compat')) {
      let bytes = await readFile(`artifacts/core/compat/${name}`);
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.compatibilityFiles[name]) throw new Error(`Unverified core adapter: ${name}`);
      if (name === 'sqlite.mjs' && process.env.CORE_CANONICAL_BATCHING !== '1') {
        const method = 'collectOpenClawCanonicalStrictTables()';
        const source = bytes.toString('utf8');
        if (source.split(method).length !== 2) throw new Error('Canonical batching control boundary changed');
        bytes = Buffer.from(source.replace(method, '__disabledCollectOpenClawCanonicalStrictTables()'));
      }
      await stageFs.writeFile(`/core/compat/${name}`, bytes);
    }
    const packageRequire = createRequire(await realpath('node_modules/openclaw/package.json'));
    await stageFs.writeFile('/core/web-tree-sitter.wasm', await readFile(join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')));
    await stageFs.mkdir('/core/node_modules/tree-sitter-bash', { recursive: true });
    await stageFs.writeFile('/core/node_modules/tree-sitter-bash/package.json', JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
    await stageFs.writeFile('/core/node_modules/tree-sitter-bash/tree-sitter-bash.wasm', await readFile(packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));
    await stageFs.writeFile('/core/capabilities.mjs', await compileFixture(await readFile('test/fixtures/capabilities.mjs', 'utf8')));
    artifactStore?.seal();
  }

  if (artifactStore) await stage();
  // Published chunked_local initializes its root as guest uid 0 even with uid
  // config supplied. Provision ownership once, then run tests as guest uid 1000.
  const setup = await AgentOs.create({ ...options, user: { uid: 0, gid: 0 } });
  try {
    const result = await setup.process.execFile('node', ['-e', "const fs=require('fs');for(const p of ['/workspace','/state']){fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)}"], { output: { capture: 'all' } });
    if (result.exitCode !== 0) throw new Error(`Mount ownership setup failed: ${result.stderr}`);
  } finally { await setup.dispose(); }
  vm = await AgentOs.create(options);
  if (!artifactStore) await stage();
  const capabilities = await vm.process.execFile('node', ['/core/capabilities.mjs'], { timeoutMs: 30000, output: { capture: 'all' } });
  reports.push({ generation: 'capabilities', result: capabilities });
  console.log(JSON.stringify({ generation: 'capabilities', result: capabilities }, null, 2));
  if (capabilities.outcome !== 'succeeded' || capabilities.exitCode !== 0) process.exitCode = 1;
  for (const generation of ['initial', 'restored']) {
    if (generation === 'restored') {
      await vm.dispose();
      sqlite.dispose();
      vm = await AgentOs.create(options);
      if (!artifactStore) await stage();
      if (!(await vm.filesystem.exists('/state/transcript.json'))) throw new Error('Guest transcript did not survive VM recreation');
    }
    const started = performance.now();
    const before = sqlite.stats.calls;
    const result = await vm.process.execFile('node', ['/core/probe.mjs', '--internal-worker-prewarm'], {
      env: { CORE_PHASES: generation === 'initial' ? 'tools,resume' : 'resume', CORE_FAILURES: generation === 'initial' ? '1' : '0', OPENCLAW_STATE_DIR: '/state/openclaw', OPENCLAW_CHILD_OOM_SCORE_ADJ: '0' },
      timeoutMs: 90000, output: { capture: 'all' },
    });
    const report = { generation, durationMs: Math.round(performance.now() - started), sqliteCalls: sqlite.stats.calls - before, result };
    const canonicalResult = result.stdout?.match(/^CANONICAL_BATCH_RESULT=(.+)$/m);
    if (!canonicalResult || JSON.parse(canonicalResult[1]).enabled !== (process.env.CORE_CANONICAL_BATCHING === '1')) throw new Error('Canonical batching mode was not exercised as requested');
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    if (/failed to asynchronously prepare wasm|Aborted\(Error:.*\/core\//.test(result.stderr ?? '')) throw new Error('Core parser asset failed to load');
    if (result.outcome !== 'succeeded' || result.exitCode !== 0) { process.exitCode = 1; }
  }
  completed = true;
} finally {
  await mkdir('artifacts/results', { recursive: true });
  const validationPassed = completed && reports.length === 3 && reports.every(report => report.result.exitCode === 0 && report.result.outcome === 'succeeded');
  await writeFile(reportPath, JSON.stringify({ statementCacheSize, recordedAt: new Date().toISOString(), node: process.version, artifactMode, canonicalBatching: process.env.CORE_CANONICAL_BATCHING === '1', validationPassed, openclaw: '2026.8.1', agentos: '0.2.19', runtimeEnvironment: Object.fromEntries(['MALLOC_ARENA_MAX', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_MMAP_THRESHOLD_', 'MALLOC_TOP_PAD_', 'GLIBC_TUNABLES', 'AGENTOS_V8_WARM_ISOLATES'].map(key => [key, process.env[key] ?? null])), sqlite: sqlite.stats, reports }, null, 2) + '\n');
  await vm?.dispose(); sqlite.dispose(); await vm?.sidecar.dispose(); await artifactStore?.dispose(); await rm(sqliteRoot, { recursive: true, force: true });
}
