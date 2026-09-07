import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deferNativeCoreInitialization } from '../scripts/defer-native-core-init.mjs';
import { splitNativeHighlight } from '../scripts/split-native-highlight.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('lazy artifact preserves configuration validation, locale and complete highlighting APIs', { timeout: 180000 }, async t => {
  const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
  const eager = await readFile('artifacts/core/eager-native-core.mjs', 'utf8');
  const lazy = await readFile('artifacts/core/native-core.mjs', 'utf8');
  const bundled = await readFile('artifacts/core/bundled-native-core.mjs', 'utf8');
  assert.equal(hash(eager), manifest.eagerNativeCoreSha256);
  assert.equal(hash(lazy), manifest.nativeCoreSha256);
  assert.equal(bundled, deferNativeCoreInitialization(eager).source);
  assert.equal(hash(bundled), manifest.bundledNativeCoreSha256);
  const before = await readFile('artifacts/core/before-allocations-native-core.mjs', 'utf8');
  assert.equal(before, deferNativeCoreInitialization(eager).beforeAllocationsSource);
  assert.equal(hash(before), manifest.beforeAllocationsNativeCoreSha256);
  const split = splitNativeHighlight(bundled);
  assert.ok(['split', 'bundled'].includes(manifest.nativeLayout.mode));
  assert.equal(lazy, manifest.nativeLayout.mode === 'split' ? split.source : bundled);
  assert.equal(await readFile('artifacts/core/split-native-core.mjs', 'utf8'), split.source);
  assert.equal(await readFile('artifacts/core/native-highlight.cjs', 'utf8'), split.moduleSource);
  const fixture = await readFile('test/fixtures/native-lazy-init.mjs', 'utf8');
  const results = [];
  for (const [mode, core] of [['eager', eager], ['before', before], ['lazy', bundled], ['split', split.source]]) {
    const entry = `artifacts/core/init-contract-${mode}-${process.pid}.mjs`;
    t.after(() => rm(entry, { force: true }));
    const instrumented = core
      .replace('var require_lib$9=__commonJSMin(((Ot,Zt)=>{', 'var require_lib$9=__commonJSMin(((Ot,Zt)=>{__testHighlightLoads++;')
      .replace('var init_zod_schema_root_support=__esmMin((()=>{', 'var init_zod_schema_root_support=__esmMin((()=>{__testRootSupportLoads++;')
      .replace('var init_zod_schema_agent_runtime=__esmMin((()=>{', 'var init_zod_schema_agent_runtime=__esmMin((()=>{__testAgentSchemaLoads++;')
      .replace('var init_zod_schema=__esmMin((()=>{', 'var init_zod_schema=__esmMin((()=>{__testSchemaLoads++;')
      .replace('__nativeHighlightRequire("./native-highlight.cjs")()', '(__testHighlightLoads++,__nativeHighlightRequire("./native-highlight.cjs")())');
    assert.notEqual(instrumented, core);
    await writeFile(entry, `let __testHighlightLoads=0,__testSchemaLoads=0,__testAgentSchemaLoads=0,__testRootSupportLoads=0;const __testPruned=${mode === 'lazy' || mode === 'split'}, __testMode=${JSON.stringify(mode === 'eager' ? 'eager' : 'lazy')},__testSplit=${mode === 'split'};\n` + instrumented + '\n' + fixture, { flag: 'wx' });
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'LD_PRELOAD']) delete env[key];
    for (const demand of ['mcp-first', 'config-first']) {
      const result = spawnSync(process.execPath, ['scripts/run-core-node-request.mjs', entry], { env: { ...env, TEST_SCHEMA_DEMAND: demand }, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(result.stderr, '');
      results.push(JSON.parse(result.stdout));
    }
  }
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
  assert.ok(results[0].languages.length > 150);
  assert.ok(results[0].configs.some(result => result.ok));
  assert.ok(results[0].configs.some(result => !result.ok));
});

test('artifact patch refuses extra schema consumers and moved loader boundaries', async () => {
  const core = await readFile('artifacts/core/eager-native-core.mjs', 'utf8');
  assert.throws(() => deferNativeCoreInitialization(core + '\nfunction newConsumer(){return OpenClawSchema;}'), /reference boundary changed/);
  assert.throws(() => deferNativeCoreInitialization(core.replace('function getWorkerDeployHighlightJs(){return runtime$2.highlightJs}', 'function getWorkerDeployHighlightJs(){return null}')), /text boundary changed/);
});

test('unused channel schema removal refuses newly reachable locals or changed construction', async () => {
  const core = await readFile('artifacts/core/eager-native-core.mjs', 'utf8');
  for (const name of ['AllowFromEntrySchema', 'AllowFromListSchema', 'collectMcpServerNameIssues', 'init_zod_schema_root_support']) {
    assert.throws(() => deferNativeCoreInitialization(core + `\nfunction consumer(){return ${name};}`), /reference boundary changed/);
  }
  assert.throws(() => deferNativeCoreInitialization(core.replace('allowFrom:AllowFromListSchema,systemPrompt:', 'allowFrom:AllowFromListSchema.default([]),systemPrompt:')), /text boundary changed/);
});
