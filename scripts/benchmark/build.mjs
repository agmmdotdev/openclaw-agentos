import { readFile, writeFile } from 'node:fs/promises';
import { compileFixture } from '../compile-async.mjs';
import { createHash } from 'node:crypto';
const worker = await readFile('artifacts/core/worker.mjs', 'utf8');
const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
if (createHash('sha256').update(worker).digest('hex') !== manifest.outputSha256) throw new Error('Compiled worker differs from its manifest');
const fixture = await compileFixture(await readFile('test/fixtures/core-benchmark.mjs', 'utf8'));
await writeFile('artifacts/core/benchmark.mjs', worker + '\n' + fixture);
console.log('Benchmark entry built outside the measured process.');

// Direct Node baseline uses the published worker with its core export wrapper,
// native SQLite, and the same tool/inference fixture. No guest shims or lowering.
const upstream = await readFile('node_modules/openclaw/dist/worker/worker.mjs', 'utf8');
if (createHash('sha256').update(upstream).digest('hex') !== manifest.inputSha256) throw new Error('Native baseline input differs from the verified worker');
let nativeFixture = await readFile('test/fixtures/core-benchmark.mjs', 'utf8');
nativeFixture = nativeFixture.replace("import { spawnSync as benchSpawnSync } from 'node:child_process';", '');
nativeFixture = nativeFixture.replace("import { DatabaseSync as BenchDatabase, getBenchmarkSqlTiming } from './compat/sqlite.mjs';", "const { DatabaseSync: BenchDatabase } = await import('node:sqlite');");
const markerStart = nativeFixture.indexOf('function mark('), markerEnd = nativeFixture.indexOf("mark('worker-ready');", markerStart);
if (markerStart < 0 || markerEnd < 0) throw new Error('Native fixture marker boundary changed');
nativeFixture = nativeFixture.slice(0, markerStart) + `
const benchStart = performance.now();
const benchWorkspace = process.env.BENCH_ROOT + "/workspace", benchState = process.env.BENCH_ROOT + "/state";
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now() - benchStart, instance: 0, ...data })); }
` + nativeFixture.slice(markerEnd);
nativeFixture = nativeFixture.replaceAll("'/workspace/seed.txt'", "benchWorkspace + '/seed.txt'").replaceAll("'/workspace'", 'benchWorkspace').replaceAll("'/state/transcript.json'", "benchState + '/transcript.json'").replaceAll("'/state'", 'benchState').replaceAll("'cat /workspace/seed.txt'", "'cat ' + benchWorkspace + '/seed.txt'");
await writeFile('artifacts/core/native-benchmark.mjs', upstream + '\nasync function runOpenClawCoreTurn(params) { init_embedded_agent_runtime(); return runWorkerEmbeddedTurn(params); }\nawait (async()=>{\n' + nativeFixture + '\n})();\n');
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
