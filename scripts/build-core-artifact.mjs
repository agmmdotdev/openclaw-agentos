import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';

// Transform only module specifiers in the pinned bundle's import preamble.
// OpenClaw source and agentOS packages stay untouched. This is an artifact patch.
const input = resolve(process.env.OPENCLAW_WORKER ?? 'node_modules/openclaw/dist/worker/worker.mjs');
const output = resolve('artifacts/core');
const source = await readFile(input, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
const expected = '03eca1d346aa24fd5028b2ca8d09385b764bf9dd2c82810ce564043a34356f1c';
if (sha256 !== expected) throw new Error(`Unreviewed worker artifact: ${sha256}`);
const end = source.indexOf(';var ');
if (end < 0) throw new Error('Worker import preamble changed');
const ast = ts.createSourceFile('imports.mjs', source.slice(0, end + 1), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const replacements = [];
const modules = new Map([
  ['node:crypto', 'crypto'], ['node:fs', 'fs'], ['node:module', 'module'],
  ['node:perf_hooks', 'perf-hooks'], ['node:readline/promises', 'readline-promises'],
  ['node:util', 'util'],
  ['node:async_hooks', 'async-hooks'],
]);
for (const statement of ast.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const specifier = statement.moduleSpecifier;
  const target = modules.get(specifier.text);
  if (target) replacements.push({ start: specifier.getStart(ast), end: specifier.end, from: specifier.text, to: `./compat/${target}.mjs` });
}
let transformed = source;
for (const replacement of replacements.toReversed()) {
  transformed = transformed.slice(0, replacement.start) + JSON.stringify(replacement.to) + transformed.slice(replacement.end);
}
if (!source.includes('async function runWorkerEmbeddedTurn(') || !source.includes('init_embedded_agent_runtime=__esmMin(')) throw new Error('Embedded turn boundary changed');
// Export the existing implementation; retain prewarm/worker entry behavior.
transformed += '\nexport async function runOpenClawCoreTurn(params) { init_embedded_agent_runtime(); return runWorkerEmbeddedTurn(params); }\n';
transformed = 'import "./compat/init.mjs";\n' + transformed;
await mkdir(`${output}/compat`, { recursive: true });
const compatibilityFiles = {};
for (const name of [...modules.values(), 'sqlite', 'init', 'text-decoder']) {
  const file = `${name}.mjs`;
  const bytes = await readFile(`src/core-compat/${file}`);
  compatibilityFiles[file] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${output}/compat/${file}`, bytes);
}
await writeFile(`${output}/worker.mjs`, transformed);
const manifest = { openclaw: '2026.8.1', agentos: '0.2.19', inputSha256: sha256, outputSha256: createHash('sha256').update(transformed).digest('hex'), replacements, compatibilityFiles, addedExports: ['runOpenClawCoreTurn'], invokesUpstreamInitializer: 'init_embedded_agent_runtime' };
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, inputSha256: sha256, replacements: replacements.length }));
