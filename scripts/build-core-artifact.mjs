import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { prepareCoreProfile } from './core-profile.mjs';
import { compileAsync, asyncCompiler } from './compile-async.mjs';

// Rewrite imports, then lower async syntax for agentOS promise context capture.
// OpenClaw source and agentOS packages stay untouched. This is an artifact patch.
const input = resolve(process.env.OPENCLAW_WORKER ?? 'node_modules/openclaw/dist/worker/worker.mjs');
const output = resolve('artifacts/core');
const source = await readFile(input, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
const expected = '03eca1d346aa24fd5028b2ca8d09385b764bf9dd2c82810ce564043a34356f1c';
if (sha256 !== expected) throw new Error(`Unreviewed worker artifact: ${sha256}`);
const profile = process.env.CORE_PROFILE ?? 'core';
if (!['core', 'full'].includes(profile)) throw new Error('Unknown CORE_PROFILE');
const prepared = profile === 'core' ? prepareCoreProfile(source) : { source };
const ast = ts.createSourceFile('worker.mjs', prepared.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const replacements = [];
const modules = new Map([
  ['node:crypto', 'crypto'], ['node:fs', 'fs'], ['node:module', 'module'],
  ['node:perf_hooks', 'perf-hooks'], ['node:readline/promises', 'readline-promises'],
  ['node:util', 'util'],
  ['node:async_hooks', 'async-hooks'],
  ['node:child_process', 'child-process'],
]);
for (const statement of ast.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const specifier = statement.moduleSpecifier;
  const target = modules.get(specifier.text);
  if (target) replacements.push({ start: specifier.getStart(ast), end: specifier.end, from: specifier.text, to: `./compat/${target}.mjs` });
}
let transformed = prepared.source;
for (const replacement of replacements.toReversed()) {
  transformed = transformed.slice(0, replacement.start) + JSON.stringify(replacement.to) + transformed.slice(replacement.end);
}
if (!source.includes('async function runWorkerEmbeddedTurn(') || !source.includes('init_embedded_agent_runtime=__esmMin(')) throw new Error('Embedded turn boundary changed');
// Export the existing implementation. Only the full profile retains the worker CLI.
if (profile === 'full') transformed += '\nexport async function runOpenClawCoreTurn(params) { init_embedded_agent_runtime(); return runWorkerEmbeddedTurn(params); }\n';
transformed = 'import "./compat/init.mjs";\n' + transformed;
// Preserve module evaluation waiting for the upstream command, while moving its
// sole top-level await into a compilable async function. Match the pinned text.
const entry = 'internalWorkerPrewarm?flushCompileCache():await runWorkerProcess({internalWorkerIpc,managed,browserRuntime:worker_deploy_browser_runtime_default});';
if (profile === 'full' && transformed.split(entry).length !== 2) throw new Error('Worker entry boundary changed');
if (profile === 'full') transformed = transformed.replace(entry, `const workerEntryReady=(async()=>{${entry}})();`);
// Lowered generators are functions returning iterators, so their function
// prototype cannot stand in for the native async iterator intrinsic.
const intrinsic = 'Object.getPrototypeOf(Object.getPrototypeOf(async function*(){}).prototype)';
const intrinsicReferences = transformed.split(intrinsic).length - 1;
if (intrinsicReferences !== (profile === 'full' ? 3 : 2)) throw new Error('Async iterator intrinsic references changed');
transformed = 'import { nativeAsyncIteratorPrototype as __agentosAsyncIteratorPrototype } from "./compat/async-intrinsics.mjs";\n' + transformed.replaceAll(intrinsic, '__agentosAsyncIteratorPrototype');
await mkdir(output, { recursive: true });
await writeFile(`${output}/native-core.mjs`, prepared.source);
transformed = await compileAsync(transformed) + (profile === 'full' ? '\nawait workerEntryReady;\n' : '');
await mkdir(`${output}/compat`, { recursive: true });
const compatibilityFiles = {};
for (const name of [...modules.values(), 'sqlite', 'init', 'text-decoder', 'async-intrinsics']) {
  const file = `${name}.mjs`;
  const bytes = await readFile(`src/core-compat/${file}`);
  compatibilityFiles[file] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${output}/compat/${file}`, bytes);
}
await writeFile(`${output}/worker.mjs`, transformed);
const manifest = { profile, profileReport: prepared.report, inputBytes: Buffer.byteLength(source), nativeCoreBytes: Buffer.byteLength(prepared.source), outputBytes: Buffer.byteLength(transformed), nativeCoreSha256: createHash('sha256').update(prepared.source).digest('hex'), openclaw: '2026.8.1', agentos: '0.2.19', inputSha256: sha256, outputSha256: createHash('sha256').update(transformed).digest('hex'), asyncCompiler, intrinsicReferences, replacements, compatibilityFiles, addedExports: ['runOpenClawCoreTurn'], invokesUpstreamInitializer: 'init_embedded_agent_runtime' };
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, inputSha256: sha256, replacements: replacements.length }));
