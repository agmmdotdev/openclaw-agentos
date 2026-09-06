import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { sliceCoreArtifact } from './slice-core-artifact.mjs';
import { prepareCoreProfile } from './core-profile.mjs';
import { compileAsync, asyncCompiler } from './compile-async.mjs';
import { deferNativeCoreInitialization } from './defer-native-core-init.mjs';

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
// Keep upstream database creation, schema execution, and finally/close in the
// guest. Extract only the existing read-only metadata scan from its try block.
const canonicalAnchor = 'function readCanonicalStrictTables(Ot){';
if (prepared.source.split(canonicalAnchor).length !== 2) throw new Error('Canonical table scan boundary changed');
const canonicalStart = prepared.source.indexOf(canonicalAnchor);
const canonicalAst = ts.createSourceFile('canonical.mjs', prepared.source.slice(canonicalStart, canonicalStart + 6000), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const canonicalFunction = canonicalAst.statements[0];
const canonicalTry = canonicalFunction.body?.statements[1];
if (!ts.isFunctionDeclaration(canonicalFunction) || !canonicalTry || !ts.isTryStatement(canonicalTry)
  || canonicalTry.tryBlock.statements[0]?.getText(canonicalAst) !== 'Zt.exec(Ot);') throw new Error('Canonical scan structure changed');
const canonicalCollector = 'function collectCanonicalStrictTableMetadata(Zt){' + canonicalTry.tryBlock.statements.slice(1).map(statement => statement.getText(canonicalAst)).join('') + '}';
const rowidAliases = 'SQLITE_ROWID_ALIASES=[`_rowid_`,`rowid`,`oid`]';
if (prepared.source.split(rowidAliases).length !== 2) throw new Error('Canonical rowid aliases changed');
// Extract the original read-only collector before installing the guest hook.
// It accepts an already-authorized database handle; it opens no connections.
const schemaCollector = sliceCoreArtifact(prepared.source + '\n' + canonicalCollector, {
  roots: ['init_sqlite_schema_sql', 'collectSqliteTableContract', 'collectSqliteNamedIndexContract', 'collectCanonicalStrictTableMetadata'], registerRuntime: false,
  wrapper: `\ninit_sqlite_schema_sql(); ${rowidAliases}; export { collectSqliteTableContract, collectSqliteNamedIndexContract, collectCanonicalStrictTableMetadata };\n`,
});
if (/^import\s/m.test(schemaCollector.source) || Buffer.byteLength(schemaCollector.source) > 40000) {
  throw new Error('Schema collector dependency boundary expanded');
}
const canonicalHook = canonicalAnchor + 'let Zt=openNodeSqliteDatabase(`:memory:`);try{Zt.exec(Ot);';
if (prepared.source.split(canonicalHook).length !== 2) throw new Error('Canonical metadata hook changed');
prepared.source = prepared.source.replace(canonicalHook, canonicalHook + 'if(typeof Zt.collectOpenClawCanonicalStrictTables===`function`)return Zt.collectOpenClawCanonicalStrictTables();');
const collectorAnchor = 'function collectSqliteTableContract(Ot,Zt){';
if (prepared.source.split(collectorAnchor).length !== 2) throw new Error('Schema collector hook boundary changed');
prepared.source = prepared.source.replace(collectorAnchor, collectorAnchor +
  'if(typeof Ot.collectOpenClawTableContract===`function`)return Ot.collectOpenClawTableContract(Zt);');
const indexAnchor = 'function collectSqliteNamedIndexContract(Ot,Zt){';
if (prepared.source.split(indexAnchor).length !== 2) throw new Error('Named index collector hook boundary changed');
prepared.source = prepared.source.replace(indexAnchor, indexAnchor +
  'if(typeof Ot.collectOpenClawNamedIndexContract===`function`)return Ot.collectOpenClawNamedIndexContract(Zt);');
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
const nativeInitMode = process.env.NATIVE_CORE_INIT ?? (profile === 'core' ? 'lazy' : 'eager');
if (!['eager', 'lazy'].includes(nativeInitMode) || (profile !== 'core' && nativeInitMode === 'lazy')) throw new Error('Invalid NATIVE_CORE_INIT for this profile');
const nativePrepared = nativeInitMode === 'lazy' ? deferNativeCoreInitialization(prepared.source) : { source: prepared.source, report: { mode: 'eager' } };
await writeFile(`${output}/eager-native-core.mjs`, prepared.source);
await writeFile(`${output}/native-core.mjs`, nativePrepared.source);
await writeFile(`${output}/schema-collector.mjs`, schemaCollector.source);
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
const manifest = { schemaCollector: { sha256: createHash('sha256').update(schemaCollector.source).digest('hex'), bytes: Buffer.byteLength(schemaCollector.source), roots: schemaCollector.report.roots }, profile, profileReport: prepared.report, inputBytes: Buffer.byteLength(source), nativeCoreBytes: Buffer.byteLength(prepared.source), outputBytes: Buffer.byteLength(transformed), nativeCoreSha256: createHash('sha256').update(prepared.source).digest('hex'), openclaw: '2026.8.1', agentos: '0.2.19', inputSha256: sha256, outputSha256: createHash('sha256').update(transformed).digest('hex'), asyncCompiler, intrinsicReferences, replacements, compatibilityFiles, addedExports: ['runOpenClawCoreTurn'], invokesUpstreamInitializer: 'init_embedded_agent_runtime' };
manifest.nativeCoreBytes = Buffer.byteLength(nativePrepared.source);
manifest.nativeCoreSha256 = createHash('sha256').update(nativePrepared.source).digest('hex');
manifest.nativeInitialization = nativePrepared.report;
manifest.eagerNativeCoreSha256 = createHash('sha256').update(prepared.source).digest('hex');
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, inputSha256: sha256, replacements: replacements.length }));
