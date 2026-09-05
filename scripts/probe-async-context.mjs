import { AgentOs } from '@rivet-dev/agentos-core';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compileFixture, asyncCompiler } from './compile-async.mjs';
const source = await readFile('test/fixtures/async-context.mjs', 'utf8');
const nativeSource = source.replace('./compat/async-hooks.mjs', 'node:async_hooks');
const nodeOutput = execFileSync(process.execPath, ['--input-type=module', '-e', nativeSource], { encoding: 'utf8', timeout: 10000 });
const compiledNodeOutput = execFileSync(process.execPath, ['--input-type=module', '-e', await compileFixture(nativeSource)], { encoding: 'utf8', timeout: 10000 });
const vm = await AgentOs.create();
try {
  await vm.filesystem.mkdir('/probe/compat', { recursive: true });
  await vm.filesystem.writeFile('/probe/compat/async-hooks.mjs', await readFile('src/core-compat/async-hooks.mjs'));
  const results = {};
  for (const [name, code] of Object.entries({ native: nativeSource, adapterWithoutLowering: source, adapted: await compileFixture(source) })) {
    await vm.filesystem.writeFile(`/probe/${name}.mjs`, code);
    results[name] = await vm.process.execFile('node', [`/probe/${name}.mjs`], { timeoutMs: 10000, output: { capture: 'all' } });
  }
  const adaptedMatchesNode = results.adapted.exitCode === 0 && results.adapted.stdout === nodeOutput;
  const compiledNodeMatchesNative = compiledNodeOutput === nodeOutput;
  const report = { recordedAt: new Date().toISOString(), node: process.version, agentos: '0.2.19', asyncCompiler, nodeOutput, compiledNodeMatchesNative, results, adaptedMatchesNode };
  await mkdir('artifacts/results', { recursive: true });
  await writeFile('artifacts/results/async-context.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!adaptedMatchesNode || !compiledNodeMatchesNative) process.exitCode = 1;
} finally { await vm.dispose(); }
