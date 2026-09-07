// Instrumented diagnosis, never a replacement for process-tree benchmarks.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const trial = process.argv[2];
if (!/^\d+$/.test(trial ?? '')) throw new Error('Usage: node scripts/diagnostics/profile-native-startup.mjs TRIAL');
const output = `artifacts/results/startup-initializers-${trial}.json`;
const eager = process.argv.includes('--eager');
const bundled = process.argv.includes('--bundled');
const beforeAllocations = process.argv.includes('--before-allocations');
if ([eager, bundled, beforeAllocations].filter(Boolean).length > 1) throw new Error('Choose at most one initialization control');
const core = await readFile(eager ? 'artifacts/core/eager-native-core.mjs' : beforeAllocations ? 'artifacts/core/before-allocations-native-core.mjs' : bundled ? 'artifacts/core/bundled-native-core.mjs' : 'artifacts/core/native-core.mjs', 'utf8');
const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(core) !== (eager ? manifest.eagerNativeCoreSha256 : beforeAllocations ? manifest.beforeAllocationsNativeCoreSha256 : bundled ? manifest.bundledNativeCoreSha256 : manifest.nativeCoreSha256)) throw new Error('Native core differs from manifest');
if (!eager && !bundled && !beforeAllocations && manifest.nativeLayout?.mode === 'split' && hash(await readFile('artifacts/core/native-highlight.cjs')) !== manifest.nativeLayout.highlight.moduleSha256) throw new Error('Highlighter differs from manifest');
const prefix = `
const __startupRows=[], __startupStack=[], __startupEvaluationStart=performance.now();
function __startupWrap(helper,name,fn) { return helper(function(...args) {
  const frame={name,children:0},start=performance.now();__startupStack.push(frame);
  try { return Reflect.apply(fn,this,args); }
  finally { const totalMs=performance.now()-start;__startupStack.pop();
    if(__startupStack.length)__startupStack.at(-1).children+=totalMs;
    __startupRows.push({name,totalMs,selfMs:totalMs-frame.children}); }
}); }
`;
let count = 0;
const instrumented = core.replace(/([\w$]+)=(__esmMin|__commonJSMin)\(/g, (_, name, helper) => {
  count++; return `${name}=__startupWrap(${helper},${JSON.stringify(name)},`;
});
if (count < 100) throw new Error('Initializer instrumentation boundary changed');
const suffix = `
const __startupPhases=[{name:'eager-evaluation',ms:performance.now()-__startupEvaluationStart,memory:process.memoryUsage()}];
async function __startupPhase(name,fn) {
  const start=performance.now(),cpu=process.cpuUsage();await fn();
  __startupPhases.push({name,ms:performance.now()-start,cpu:process.cpuUsage(cpu),memory:process.memoryUsage()});
}
await __startupPhase('embedded-init',()=>init_embedded_agent_runtime());
await __startupPhase('parser-load',()=>getBashParserForCommandExplanation());
for (const name of ['parser-first-parse','parser-second-parse']) await __startupPhase(name,async()=>{
  const tree=await parseBashForCommandExplanation('node scripts/search.cjs');
  try { if(tree.rootNode.hasError)throw new Error('Bash parse failed'); } finally { tree.delete(); }
});
${process.argv.includes('--deferred-use') ? `
await __startupPhase('config-first-validation',()=>{if(!validateConfigObjectRaw({}).ok)throw new Error('Configuration rejected');});
await __startupPhase('highlight-first-use',()=>getWorkerDeployHighlightJs().highlight('const value=42;', {language:'javascript'}));
await __startupPhase('config-second-validation',()=>{if(!validateConfigObjectRaw({}).ok)throw new Error('Configuration rejected');});
await __startupPhase('highlight-second-use',()=>getWorkerDeployHighlightJs().highlight('const value=42;', {language:'javascript'}));
` : ''}
console.log(JSON.stringify({node:process.version,v8:process.versions.v8,uptimeMs:process.uptime()*1000,phases:__startupPhases,initializers:__startupRows.sort((a,b)=>b.selfMs-a.selfMs)}));
`;
const entry = resolve(`artifacts/core/startup-instrumented-${trial}.mjs`);
await writeFile(entry, prefix + instrumented + suffix);
const runs = [];
for (const profile of ['default', 'request']) {
  const env = { ...process.env, MALLOC_ARENA_MAX: '1', MALLOC_TRIM_THRESHOLD_: '65536', MALLOC_MMAP_THRESHOLD_: '65536' };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'LD_PRELOAD']) delete env[key];
  const traceArgs = process.argv.includes('--trace-wasm') ? ['--trace-wasm-compilation-times'] : [];
  const args = profile === 'request' ? ['scripts/run-core-node-request.sh', ...traceArgs, entry] : ['--max-semi-space-size=8', ...traceArgs, entry];
  const start = performance.now();
  const result = spawnSync(profile === 'request' ? 'sh' : process.execPath, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  const lines = result.stdout.trim().split('\n');
  const payload = lines.filter(line => line.startsWith('{'));
  if (payload.length !== 1) throw new Error('Unexpected diagnostic output');
  runs.push({ profile, wallMs: performance.now() - start, ...JSON.parse(payload[0]), engineTrace: lines.filter(line => !line.startsWith('{')), stderr: result.stderr });
}
await writeFile(output, JSON.stringify({ instrumented: true, eager, bundled, beforeAllocations, nativeLayout: manifest.nativeLayout, deferredUse: process.argv.includes('--deferred-use'), initializerCount: count, coreSha256: hash(core), generatedSha256: hash(prefix + instrumented + suffix), runs }, null, 2) + '\n', { flag: 'wx' });
console.log(output);
