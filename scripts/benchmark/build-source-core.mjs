import { readFile, writeFile, mkdir } from 'node:fs/promises';
const baseFixture = await readFile('test/fixtures/core-benchmark.mjs', 'utf8');
const completionStart = baseFixture.indexOf('if (!globalThis.__benchmarkRequestState) {');
const completionEnd = baseFixture.indexOf('// Isolate primitive runtime costs', completionStart);
if (completionStart < 0 || completionEnd <= completionStart) throw new Error('Completion fixture boundary changed');
const completion = baseFixture.slice(completionStart, completionEnd);
let fixture = await readFile('test/fixtures/core-workload-benchmark.mjs', 'utf8');
if (fixture.split("const workspace = '/workspace', state = '/state';").length !== 2) throw new Error('Source fixture path boundary changed');
fixture = fixture.replace("const workspace = '/workspace', state = '/state';", "const workspace = process.env.BENCH_ROOT + '/workspace', state = process.env.BENCH_ROOT + '/state';");
if (fixture.includes("const workspace = '/workspace'")) throw new Error('Source fixture path replacement failed');
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const setup = `
import * as fs from 'node:fs';
import { runOpenClawCoreTurn as runCore } from '../../packages/openclaw-core/dist/${prefix}index.mjs';
import { createNativeSdkAdapter } from '../../scripts/benchmark/native-sdk-adapter.mjs';
import { createAgentOsToolRuntime } from '../../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs';
import { beginRequest } from '../../packages/openclaw-core/src/request-state.mjs';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const started = performance.now();
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now()-started, instance: 0, ...data })); }
const hybrid = await createNativeSdkAdapter(process.env.BENCH_ROOT, createAgentOsToolRuntime);
globalThis.__benchmarkWorkspaceBridge = hybrid.sandbox.fsBridge;
if (process.env.BENCH_REQUEST_TURN !== undefined) globalThis.__benchmarkRequestState = await beginRequest(process.env.BENCH_ROOT + '/state', Number(process.env.BENCH_REQUEST_TURN));
function runOpenClawCoreTurn(params) { return runCore({ ...params, toolRuntime: { sandbox: hybrid.sandbox, supervisor: hybrid.supervisor } }); }
const { DatabaseSync: BenchDatabase } = await import('node:sqlite');
fs.writeFileSync(process.env.BENCH_ROOT + '/workspace/seed.txt', 'benchmark-seed\\n');
mark('worker-ready');
`;
await mkdir('artifacts/core', { recursive: true });
await writeFile(`artifacts/core/${prefix}source-native-sdk-core-benchmark.mjs`, setup + '\n' + fixture + '\ntry { await runRepresentativeBenchmarks();\n' + completion + '\nconsole.log("NATIVE_SDK_COUNTS=" + JSON.stringify(hybrid.counts)); } finally { await hybrid.dispose(); }\n');
