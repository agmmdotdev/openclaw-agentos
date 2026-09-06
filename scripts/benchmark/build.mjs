import { readFile, writeFile } from 'node:fs/promises';
import { compileFixture } from '../compile-async.mjs';
import { createHash } from 'node:crypto';
const worker = await readFile('artifacts/core/worker.mjs', 'utf8');
const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
if (createHash('sha256').update(worker).digest('hex') !== manifest.outputSha256) throw new Error('Compiled worker differs from its manifest');
const fixtureSource = await readFile('test/fixtures/core-benchmark.mjs', 'utf8') + '\n' + await readFile('test/fixtures/core-workload-benchmark.mjs', 'utf8');
const fixture = await compileFixture(fixtureSource);
await writeFile('artifacts/core/benchmark.mjs', worker + '\n' + fixture);
console.log('Benchmark entry built outside the measured process.');

// Direct Node baseline uses the published worker with its core export wrapper,
// native SQLite, and the same tool/inference fixture. No guest shims or lowering.
const upstream = await readFile('node_modules/openclaw/dist/worker/worker.mjs', 'utf8');
if (createHash('sha256').update(upstream).digest('hex') !== manifest.inputSha256) throw new Error('Native baseline input differs from the verified worker');
let nativeFixture = fixtureSource;
nativeFixture = nativeFixture.replace("import benchChildProcess from './compat/child-process.mjs';", "const benchChildProcess = await import('node:child_process');");
nativeFixture = nativeFixture.replace("import { spawnSync as benchSpawnSync } from 'node:child_process';", '');
nativeFixture = nativeFixture.replace("import { DatabaseSync as BenchDatabase, getBenchmarkSqlTiming } from './compat/sqlite.mjs';", "const { DatabaseSync: BenchDatabase } = await import('node:sqlite');");
const markerStart = nativeFixture.indexOf('function mark('), markerEnd = nativeFixture.indexOf("mark('worker-ready');", markerStart);
if (markerStart < 0 || markerEnd < 0) throw new Error('Native fixture marker boundary changed');
nativeFixture = nativeFixture.slice(0, markerStart) + `
const memoryCheckpoint = process.env.BENCH_NATIVE_MEMORY === "1" ? (await import("../../scripts/benchmark/native-memory.mjs")).nativeMemoryCheckpoint : () => ({});
const benchStart = performance.now();
const benchWorkspace = process.env.BENCH_ROOT + "/workspace", benchState = process.env.BENCH_ROOT + "/state";
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now() - benchStart, instance: 0, ...data, ...memoryCheckpoint(label) })); }
` + nativeFixture.slice(markerEnd);
nativeFixture = nativeFixture.replaceAll("'/tmp/boundary-seed.txt'", "process.env.BENCH_ROOT + '/boundary-seed.txt'");
nativeFixture = nativeFixture.replaceAll("'/workspace/seed.txt'", "benchWorkspace + '/seed.txt'").replaceAll("'/workspace'", 'benchWorkspace').replaceAll("'/state/transcript.json'", "benchState + '/transcript.json'").replaceAll("'/state'", 'benchState').replaceAll("'cat /workspace/seed.txt'", "'cat ' + benchWorkspace + '/seed.txt'");
await writeFile('artifacts/core/native-benchmark.mjs', upstream + '\nasync function runOpenClawCoreTurn(params) { init_embedded_agent_runtime(); return runWorkerEmbeddedTurn(params); }\nawait (async()=>{\n' + nativeFixture + '\n})();\n');
const nativeCore = await readFile('artifacts/core/native-core.mjs', 'utf8');
if (createHash('sha256').update(nativeCore).digest('hex') !== manifest.nativeCoreSha256) throw new Error('Native core differs from manifest');
await writeFile('artifacts/core/native-core-benchmark.mjs', nativeCore + '\nawait (async()=>{\n' + nativeFixture + '\n})();\n');
// The native baseline resolves the same parser WASM assets beside its entry.
const { mkdir, realpath } = await import('node:fs/promises');
const { createRequire } = await import('node:module');
const { dirname, join } = await import('node:path');
const packageRequire = createRequire(await realpath('node_modules/openclaw/package.json'));
await writeFile('artifacts/core/web-tree-sitter.wasm', await readFile(join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm')));
await mkdir('artifacts/core/node_modules/tree-sitter-bash', { recursive: true });
await writeFile('artifacts/core/node_modules/tree-sitter-bash/package.json', JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
await writeFile('artifacts/core/node_modules/tree-sitter-bash/tree-sitter-bash.wasm', await readFile(packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm')));

// Isolate lowering from the guest/runtime adapters: compiled core on real Node,
// with native builtins and SQLite restored. Keep only the native intrinsic shim.
let nativeCompiled = worker.replace('import"./compat/init.mjs";', '');
for (const replacement of manifest.replacements) nativeCompiled = nativeCompiled.replaceAll(JSON.stringify(replacement.to), JSON.stringify(replacement.from));
if (/\.\/compat\/(?!async-intrinsics)/.test(nativeCompiled)) throw new Error('A guest adapter remains in the native compiled baseline');
await writeFile('artifacts/core/native-compiled-benchmark.mjs', nativeCompiled + '\nawait (async()=>{\n' + nativeFixture + '\n})();\n');

// Keep original native tools; inject their existing sandbox interfaces only.
const hybridSetup = `
const { createHybridAdapter } = await import('../../scripts/benchmark/hybrid-adapter.mjs');
if (process.env.BENCH_WORKLOAD === 'boundaries') throw new Error('Hybrid boundary microbenchmarks are not implemented');
const hybrid = await createHybridAdapter(process.env.BENCH_ROOT);
globalThis.__benchmarkWorkspaceBridge = hybrid.sandbox.fsBridge;
init_embedded_agent_runtime();
const originalCodingTools = createCoreCodingTools;
createCoreCodingTools = options => originalCodingTools({ ...options, sandbox: hybrid.sandbox, execDefaults: { ...options.execDefaults, host: 'sandbox' } });
const supervisor = getProcessSupervisor();
supervisor.spawn = hybrid.spawn;
`;
let hybridFixture = nativeFixture.replace("fs.writeFileSync(benchWorkspace + '/seed.txt', 'benchmark-seed\\n');", "await hybrid.vm.filesystem.writeFile('/workspace/seed.txt', 'benchmark-seed\\n');");
hybridFixture = hybridFixture.replace("'cat ' + benchWorkspace + '/seed.txt'", "'cat /workspace/seed.txt'");
if (hybridFixture === nativeFixture || !hybridFixture.includes('await hybrid.vm.filesystem.writeFile')) throw new Error('Hybrid fixture boundary changed');
await writeFile('artifacts/core/hybrid-core-benchmark.mjs', nativeCore + '\n' + hybridSetup + '\ntry { await (async()=>{\n' + hybridFixture + '\n})(); if ((process.env.BENCH_WORKLOAD ?? "core-shell") === "core-shell" && (hybrid.counts.read !== Number(process.env.BENCH_WARM_TURNS ?? 5) + 1 || hybrid.counts.shell !== hybrid.counts.read)) throw new Error("Hybrid tool delegation count mismatch"); console.log("HYBRID_COUNTS=" + JSON.stringify(hybrid.counts)); } finally { await hybrid.dispose(); }\n');
await writeFile('artifacts/core/hybrid-probe.mjs', nativeCore + '\n' + hybridSetup + '\ntry {\n' + await readFile('test/fixtures/hybrid-probe.mjs', 'utf8') + '\n} finally { await hybrid.dispose(); }\n');

// Same native core and real OpenClaw tools, backed by the published Wasmer SDK.
const wasmerSetup = hybridSetup.replaceAll('createHybridAdapter', 'createWasmerAdapter').replace('hybrid-adapter.mjs', 'wasmer-adapter.mjs');
await writeFile('artifacts/core/wasmer-core-benchmark.mjs', nativeCore + '\n' + wasmerSetup + '\ntry { await (async()=>{\n' + hybridFixture + '\n})(); console.log("WASMER_COUNTS=" + JSON.stringify(hybrid.counts)); } finally { await hybrid.dispose(); }\n');
await writeFile('artifacts/core/wasmer-probe.mjs', nativeCore + '\n' + wasmerSetup + '\ntry {\n' + await readFile('test/fixtures/hybrid-probe.mjs', 'utf8') + '\n} finally { await hybrid.dispose(); }\n');

// Native SDK diagnostics keep the same host-visible workspace paths as native Node.
const nativeSdkSetup = hybridSetup.replaceAll('createHybridAdapter', 'createNativeSdkAdapter').replace('hybrid-adapter.mjs', 'native-sdk-adapter.mjs');
await writeFile('artifacts/core/native-sdk-core-benchmark.mjs', nativeCore + '\n' + nativeSdkSetup + '\ntry { await (async()=>{\n' + nativeFixture + '\n})(); console.log("NATIVE_SDK_COUNTS=" + JSON.stringify(hybrid.counts)); } finally { await hybrid.dispose(); }\n');
await writeFile('artifacts/core/native-sdk-probe.mjs', nativeCore + '\n' + nativeSdkSetup + '\ntry {\n' + await readFile('test/fixtures/native-sdk-probe.mjs','utf8') + '\n} finally { await hybrid.dispose(); }\n');

// Capture the actual fixture/build/adapter inputs and generated entries in reports.
const benchmarkHashes = {};
for (const path of ['scripts/benchmark/native-sdk-adapter.mjs', 'packages/agentos-sdk/dist/native.js', 'packages/agentos-sdk/dist/filesystem.js', 'packages/agentos-sdk/dist/native-entry.js', 'artifacts/core/native-sdk-core-benchmark.mjs', 'scripts/benchmark/wasmer-adapter.mjs', 'artifacts/core/wasmer-core-benchmark.mjs', 'scripts/benchmark/build.mjs', 'scripts/benchmark/hybrid-adapter.mjs', 'test/fixtures/core-benchmark.mjs', 'test/fixtures/core-workload-benchmark.mjs', 'artifacts/core/benchmark.mjs', 'artifacts/core/native-core-benchmark.mjs', 'artifacts/core/hybrid-core-benchmark.mjs']) {
  benchmarkHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile('artifacts/core/benchmark-manifest.json', JSON.stringify({ fixtureSourceSha256: createHash('sha256').update(fixtureSource).digest('hex'), hashes: benchmarkHashes }, null, 2) + '\n');
