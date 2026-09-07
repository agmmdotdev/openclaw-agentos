import { readFile, writeFile, mkdir } from 'node:fs/promises';
let fixture = await readFile('test/fixtures/core-workload-benchmark.mjs', 'utf8');
fixture = fixture.replace("const workspace = '/workspace', state = '/state';", "const workspace = process.env.BENCH_ROOT + '/workspace', state = process.env.BENCH_ROOT + '/state';");
if (fixture.includes("const workspace = '/workspace'")) throw new Error('Source fixture path replacement failed');
const setup = `
import * as fs from 'node:fs';
import { runOpenClawCoreTurn as runCore } from '../../packages/openclaw-core/dist/index.mjs';
import { createNativeSdkAdapter } from '../../scripts/benchmark/native-sdk-adapter.mjs';
import { beginRequest } from '../../scripts/core/request-state.mjs';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const started = performance.now();
function mark(label, data = {}) { console.log('BENCH_EVENT=' + JSON.stringify({ label, atMs: performance.now()-started, instance: 0, ...data })); }
const hybrid = await createNativeSdkAdapter(process.env.BENCH_ROOT);
globalThis.__benchmarkWorkspaceBridge = hybrid.sandbox.fsBridge;
if (process.env.BENCH_REQUEST_TURN !== undefined) globalThis.__benchmarkRequestState = await beginRequest(process.env.BENCH_ROOT + '/state', Number(process.env.BENCH_REQUEST_TURN));
function runOpenClawCoreTurn(params) { return runCore({ ...params, toolRuntime: { sandbox: hybrid.sandbox, spawn: hybrid.spawn } }); }
mark('worker-ready');
`;
await mkdir('artifacts/core', { recursive: true });
await writeFile('artifacts/core/source-native-sdk-core-benchmark.mjs', setup + '\n' + fixture + '\ntry { await runRepresentativeBenchmarks(); console.log("NATIVE_SDK_COUNTS=" + JSON.stringify(hybrid.counts)); } finally { await hybrid.dispose(); }\n');
