import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
const allowed = new Map([
  ['artifacts/core/native-sdk-core-benchmark.mjs', 'native-core.mjs'],
  ['artifacts/core/bundled-native-sdk-core-benchmark.mjs', 'bundled-native-core.mjs'],
  ['artifacts/core/before-allocations-native-sdk-core-benchmark.mjs', 'before-allocations-native-core.mjs'],
]);
if (!allowed.has(input) || !/^artifacts\/core\/startup-tail-\d+\.mjs$/.test(output ?? '')) throw new Error('Invalid startup diagnostic entry');
const source = await readFile(input, 'utf8');
const manifest = JSON.parse(await readFile('artifacts/core/benchmark-manifest.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(source) !== manifest.hashes[input]) throw new Error('Benchmark entry differs from manifest');
const core = await readFile(resolve('artifacts/core', allowed.get(input)), 'utf8');
if (!source.startsWith(core)) throw new Error('Core prefix boundary changed');
let tail = source.slice(core.length);
function mark(name) { return `globalThis.__nativeStartupMark(${JSON.stringify(name)});`; }
function replace(before, after) {
  if (tail.split(before).length !== 2) throw new Error('Startup phase boundary changed: ' + before.slice(0, 80));
  tail = tail.replace(before, after);
}
for (const [name, statement] of [
  ['sdk-import', "const { createNativeSdkAdapter } = await import('../../scripts/benchmark/native-sdk-adapter.mjs');"],
  ['sdk-create', 'const hybrid = await createNativeSdkAdapter(process.env.BENCH_ROOT);'],
  ['checkpoint', 'globalThis.__benchmarkRequestState = await beginRequest(process.env.BENCH_ROOT + "/state", Number(process.env.BENCH_REQUEST_TURN));'],
]) replace(statement, mark(name + ':start') + statement + mark(name + ':end'));
replace('init_embedded_agent_runtime();\nconst originalCodingTools', mark('embedded-init:start') + 'init_embedded_agent_runtime();' + mark('embedded-init:end') + '\nconst originalCodingTools');
replace("mark('worker-ready');", mark('worker-ready') + "mark('worker-ready');");
await writeFile(output, mark('core-evaluation:start') + '\n' + core + '\n' + mark('core-evaluation:end') + tail, { flag: 'wx' });
console.log(JSON.stringify({ inputSha256: hash(source), outputSha256: hash(await readFile(output)), output }));
