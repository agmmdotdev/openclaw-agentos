import benchChildProcess from './compat/child-process.mjs';
import { spawnSync as benchSpawnSync } from 'node:child_process';
import { DatabaseSync as BenchDatabase, getBenchmarkSqlTiming } from './compat/sqlite.mjs';
const check = (condition, message) => { if (!condition) throw new Error(message); };
function mark(label, data = {}) {
  const result = benchSpawnSync('agentos-bench', ['mark', '--json', JSON.stringify({ label, data: JSON.stringify({ ...data, guestSql: getBenchmarkSqlTiming(), fsProfile: globalThis.__benchmarkFsTiming?.() }) })], { encoding: 'utf8' });
  check(result.status === 0, `benchmark marker failed: ${result.stderr}`);
}
mark('worker-ready');
if (process.env.BENCH_PROFILE_CORE === '1') {
  init_embedded_agent_runtime();
  function profileFunction(fn, name) {
    return function (...args) {
      mark(`profile:${name}:start`);
      const start = performance.now();
      const end = () => mark(`profile:${name}:end`, { durationMs: performance.now() - start });
      try { const result = Reflect.apply(fn, this, args); if (result?.then) return result.then(value => { end(); return value; }, error => { end(); throw error; }); end(); return result; }
      catch(error) { end(); throw error; }
    };
  }
  for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
    if (typeof WebAssembly[name] === 'function') WebAssembly[name] = profileFunction(WebAssembly[name], `wasm.${name}`);
  }
  for (const name of ['Module', 'Instance']) {
    const original = WebAssembly[name];
    WebAssembly[name] = new Proxy(original, { construct(target, args, newTarget) {
      const start = performance.now(); mark(`profile:wasm.${name}:start`);
      try { return Reflect.construct(target, args, newTarget); }
      finally { mark(`profile:wasm.${name}:end`, { durationMs: performance.now() - start }); }
    } });
  }
  if (typeof getShellPathFromLoginShell === 'function') getShellPathFromLoginShell = profileFunction(getShellPathFromLoginShell, 'login-shell');
  if (typeof loadParser === 'function') loadParser = profileFunction(loadParser, 'load-bash-parser');
  if (typeof parseBashForCommandExplanation === 'function') parseBashForCommandExplanation = profileFunction(parseBashForCommandExplanation, 'parse-bash');
  if (typeof runExecProcess === 'function') runExecProcess = profileFunction(runExecProcess, 'exec-process');
  loadWorkspaceBootstrapFiles = profileFunction(loadWorkspaceBootstrapFiles, 'bootstrap');
  createCoreCodingTools = profileFunction(createCoreCodingTools, 'tools');
  createAgentSession = profileFunction(createAgentSession, 'session');
  ModelRegistry.inMemory = profileFunction(ModelRegistry.inMemory, 'models');
  AuthStorage.inMemory = profileFunction(AuthStorage.inMemory, 'auth');
  SettingsManager.inMemory = profileFunction(SettingsManager.inMemory, 'settings');
  const originalLoader = createEmbeddedAgentResourceLoader;
  createEmbeddedAgentResourceLoader = function (...args) { const result = originalLoader(...args); result.reload = profileFunction(result.reload.bind(result), 'resources'); return result; };
}

fs.writeFileSync('/workspace/seed.txt', 'benchmark-seed\n');
if (process.env.BENCH_SPLIT_INIT === '1') {
  mark('module-init:start');
  const moduleStart = performance.now();
  init_embedded_agent_runtime();
  mark('module-init:end', { durationMs: performance.now() - moduleStart });
}
const workload = process.env.BENCH_WORKLOAD ?? 'core-shell';
check(['core-shell', 'core-read', 'core-read-ready', 'core-none', 'boundaries'].includes(workload), 'Unknown benchmark workload');
mark('workload', { workload });
if (workload === 'boundaries') {
  await runBoundaryBenchmarks();
} else {
let history = [];
const warmTurns = Number(process.env.BENCH_WARM_TURNS ?? 5);
for (let turn = 0; turn <= warmTurns; turn++) {
  const label = turn === 0 ? 'cold-turn' : `warm-turn-${turn}`;
  mark(`${label}:start`);
  const start = performance.now();
  const transcript = [], terminals = [];
  let calls = 0;
  await runOpenClawCoreTurn({
    agentId: 'benchmark', operationalRunInstance: { instanceId: `bench-${turn}`, runId: `bench-${turn}` },
    agentRuntimeIdentityToken: 'test-only', cwd: '/workspace', workerContainmentRoot: '/workspace', stateDir: '/state',
    sessionId: 'benchmark', sessionKey: 'agent:benchmark:main', runId: `bench-${turn}`,
    prompt: workload === 'core-shell' ? 'Read the seed file and confirm it using the shell.' : workload !== 'core-none' ? 'Read the seed file.' : 'Say confirmed.', initialMessages: history,
    modelRef: { provider: 'openai', model: 'gpt-4.1' }, allowedToolNames: ['core-shell', 'core-read-ready'].includes(workload) ? ['read', 'exec'] : workload === 'core-read' ? ['read'] : [],
    inference: { stream(request) {
      if (process.env.BENCH_PROFILE_CORE === '1') mark('profile:inference', { turn, call: calls });
      if (calls > 0) {
        const result = request.context.messages.findLast(m => m.role === 'toolResult');
        check(result && !result.isError && result.content.some(p => p.text?.includes('benchmark-seed')), `tool output failed: ${JSON.stringify(result)}`);
        if (calls === 2) check(result.details?.status === 'completed' && result.details.exitCode === 0, 'exec completion failed');
      }
      const tools = [
        { name: 'read', arguments: { path: '/workspace/seed.txt' } },
        { name: 'exec', arguments: { command: 'cat /workspace/seed.txt', workdir: '/workspace' } },
      ];
      const toolCount = workload === 'core-shell' ? 2 : workload !== 'core-none' ? 1 : 0;
      const tool = calls < toolCount ? tools[calls] : undefined;
      calls++;
      const stopReason = tool ? 'toolUse' : 'stop';
      const message = { role: 'assistant', content: tool ? [{ type: 'toolCall', id: `bench-${turn}-${calls}`, ...tool }] : [{ type: 'text', text: 'Confirmed.' }], api: 'openai-completions', provider: 'openai', model: 'gpt-4.1', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: message }; yield { type: 'done', reason: stopReason, message }; }, result: async () => message };
    } },
    transcript: { async commit(messages) { transcript.push(...messages); fs.writeFileSync('/state/transcript.json', JSON.stringify([...history, ...transcript])); } },
    live: { enqueuePreview() { return true; }, async emitTerminal(event) { terminals.push(event); } },
  });
  const expectedCalls = workload === 'core-shell' ? 3 : workload !== 'core-none' ? 2 : 1;
  check(calls === expectedCalls && transcript.length === expectedCalls * 2 && terminals.at(-1)?.payload.stopReason === 'stop', 'incomplete benchmark turn');
  history.push(...transcript);
  mark(`${label}:end`, { durationMs: performance.now() - start, calls, transcriptMessages: history.length });
}
}
const sqlDatabase = new BenchDatabase(':memory:');
const sqlStatement = sqlDatabase.prepare('SELECT 1 AS value');
mark('sql-roundtrips:start');
const sqlStart = performance.now();
for (let i = 0; i < 50; i++) check(sqlStatement.get().value === 1, 'SQL calibration failed');
mark('sql-roundtrips:end', { durationMs: performance.now() - sqlStart, roundtrips: 50 });
sqlDatabase.close();
mark('idle:start');
await new Promise(resolve => setTimeout(resolve, 1500));
mark('idle:end');


// Isolate primitive runtime costs from OpenClaw orchestration. These variants
// are diagnostics, not substitute implementations of OpenClaw's exec tool.
async function runBoundaryBenchmarks() {
  const seedPath = '/workspace/seed.txt';
  const expected = 'benchmark-seed\n';
  const rootSeedPath = '/tmp/boundary-seed.txt';
  fs.writeFileSync(rootSeedPath, expected);
  function command(file, args) {
    return new Promise((resolve, reject) => {
      const child = benchChildProcess.spawn(file, args, { cwd: '/workspace', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code !== 0 || signal || stdout !== expected || stderr) reject(new Error(JSON.stringify({ file, code, signal, stdout, stderr })));
        else resolve(stdout.length);
      });
    });
  }
  function compute() {
    let value = 123456789;
    for (let i = 0; i < 25000000; i++) {
      value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    }
    check((value >>> 0) === 629554072, 'JavaScript checksum differs');
    return value >>> 0;
  }
  const cases = [
    ['js-cpu', 20, compute],
    ['fs-read', 5000, () => { const output = fs.readFileSync(seedPath, 'utf8'); check(output === expected, 'read differs'); return output.length; }],
    ['fs-read-root', 5000, () => { const output = fs.readFileSync(rootSeedPath, 'utf8'); check(output === expected, 'root read differs'); return output.length; }],
    ['direct-cat', 30, () => command('cat', [seedPath])],
    ['shell-cat', 30, () => command('/bin/sh', ['-c', 'cat /workspace/seed.txt'])],
    ['shell-builtin', 30, () => command('/bin/sh', ['-c', "printf 'benchmark-seed\\n'"])],
    ['child-node', 30, () => command('node', ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1]))", seedPath])],
  ];
  if (process.env.BENCH_REVERSE === '1') cases.reverse();
  for (const [name, iterations, operation] of cases) {
    for (const [phase, count] of [['cold', 1], ['warm', iterations]]) {
      mark(`boundary:${name}:${phase}:start`);
      const times = []; let checksum = 0;
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const itemStart = performance.now();
        // Await only promises: CPU/read cases must not measure microtask cost.
        const result = operation();
        checksum = (checksum + (result?.then ? await result : result)) >>> 0;
        times.push(performance.now() - itemStart);
      }
      mark(`boundary:${name}:${phase}:end`, { durationMs: performance.now() - start, iterations: count, times, checksum });
    }
  }
}
