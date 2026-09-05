import { AgentOs } from '@rivet-dev/agentos-core';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { writeLargeFile } from '../dist/src/write-large-file.js';
import { OPENCLAW_AGENTOS_NODE_BUILTINS } from '../dist/src/compatibility.js';
import { createCoreHostSqlite } from '../src/core-host-sqlite.mjs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { compileFixture } from './compile-async.mjs';

const sqliteRoot = await mkdtemp(join(tmpdir(), 'openclaw-agentos-sqlite-'));
await mkdir(join(sqliteRoot, 'databases'));
const sqlite = await createCoreHostSqlite(join(sqliteRoot, 'databases'));
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
try {
  // Published chunked_local initializes its root as guest uid 0 even with uid
  // config supplied. Provision ownership once, then run tests as guest uid 1000.
  const setup = await AgentOs.create({ ...options, user: { uid: 0, gid: 0 } });
  try {
    const result = await setup.process.execFile('node', ['-e', "const fs=require('fs');for(const p of ['/workspace','/state']){fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700)}"], { output: { capture: 'all' } });
    if (result.exitCode !== 0) throw new Error(`Mount ownership setup failed: ${result.stderr}`);
  } finally { await setup.dispose(); }
  vm = await AgentOs.create(options);
  async function stage() {
  const worker = await readFile('artifacts/core/worker.mjs', 'utf8');
  const fixture = await readFile('test/fixtures/core-turn.mjs', 'utf8');
  const failures = await readFile('test/fixtures/core-failures.mjs', 'utf8');
  const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
  const profileFixture = manifest.profile === 'core' ? await readFile('test/fixtures/core-profile.mjs', 'utf8') : '';
  // Retain the streamed entry path: the full control exceeds the 16 MiB
  // dependency response cap and the reduced profile is close to that limit.
  const runner = await compileFixture('\nfor (const coreProbePhase of (process.env.CORE_PHASES ?? \'tools\').split(\',\')) { await (async () => {\n' + fixture + '\n})(); }\nif (process.env.CORE_FAILURES === \'1\') { await (async () => {\n' + failures + '\n})(); }\n' + profileFixture);
  await writeLargeFile(vm, '/core/probe.mjs', Buffer.from(worker + '\n' + runner));
  await vm.filesystem.mkdir('/core/compat', { recursive: true });
  for (const name of await readdir('artifacts/core/compat')) await vm.filesystem.writeFile(`/core/compat/${name}`, await readFile(`artifacts/core/compat/${name}`));
  const packageRequire = createRequire(await realpath('node_modules/openclaw/package.json'));
  await vm.filesystem.writeFile('/core/web-tree-sitter.wasm', await readFile(join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')));
  await vm.filesystem.mkdir('/core/node_modules/tree-sitter-bash', { recursive: true });
  await vm.filesystem.writeFile('/core/node_modules/tree-sitter-bash/package.json', JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
  await vm.filesystem.writeFile('/core/node_modules/tree-sitter-bash/tree-sitter-bash.wasm', await readFile(packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));
  }
  await stage();
  await vm.filesystem.writeFile('/core/capabilities.mjs', await compileFixture(await readFile('test/fixtures/capabilities.mjs', 'utf8')));
  const capabilities = await vm.process.execFile('node', ['/core/capabilities.mjs'], { timeoutMs: 30000, output: { capture: 'all' } });
  reports.push({ generation: 'capabilities', result: capabilities });
  console.log(JSON.stringify({ generation: 'capabilities', result: capabilities }, null, 2));
  if (capabilities.outcome !== 'succeeded' || capabilities.exitCode !== 0) process.exitCode = 1;
  for (const generation of ['initial', 'restored']) {
    if (generation === 'restored') {
      await vm.dispose();
      sqlite.dispose();
      vm = await AgentOs.create(options);
      await stage();
      if (!(await vm.filesystem.exists('/state/transcript.json'))) throw new Error('Guest transcript did not survive VM recreation');
    }
    const started = performance.now();
    const before = sqlite.stats.calls;
    const result = await vm.process.execFile('node', ['/core/probe.mjs', '--internal-worker-prewarm'], {
      env: { CORE_PHASES: generation === 'initial' ? 'tools,resume' : 'resume', CORE_FAILURES: generation === 'initial' ? '1' : '0', OPENCLAW_STATE_DIR: '/state/openclaw', OPENCLAW_CHILD_OOM_SCORE_ADJ: '0' },
      timeoutMs: 90000, output: { capture: 'all' },
    });
    const report = { generation, durationMs: Math.round(performance.now() - started), sqliteCalls: sqlite.stats.calls - before, result };
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    if (result.outcome !== 'succeeded' || result.exitCode !== 0) { process.exitCode = 1; }
  }
} finally {
  await mkdir('artifacts/results', { recursive: true });
  await writeFile('artifacts/results/core-probe.json', JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, openclaw: '2026.8.1', agentos: '0.2.19', sqlite: sqlite.stats, reports }, null, 2) + '\n');
  await vm?.dispose(); sqlite.dispose(); await vm?.sidecar.dispose(); await rm(sqliteRoot, { recursive: true, force: true });
}
