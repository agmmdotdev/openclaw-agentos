import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { splitNativeHighlight } from '../scripts/split-native-highlight.mjs';

function run(entry) {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'LD_PRELOAD']) delete env[key];
  return spawnSync(process.execPath, ['scripts/run-core-node-request.mjs', entry], { env, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
}

test('shared highlighter module preserves independent core instances', { timeout: 60000 }, async t => {
  const core = await readFile('artifacts/core/split-native-core.mjs', 'utf8');
  const entries = ['a', 'b'].map(x => `artifacts/core/highlight-instance-${process.pid}-${x}.mjs`);
  const driver = `artifacts/core/highlight-instances-${process.pid}.mjs`;
  t.after(() => Promise.all([...entries, driver].map(path => rm(path, { force: true }))));
  for (const path of entries) await writeFile(path, core + '\nexport { getWorkerDeployHighlightJs };\n', { flag: 'wx' });
  await writeFile(driver, `
    import assert from 'node:assert/strict';
    const a=await import(${JSON.stringify('./' + entries[0].split('/').at(-1))});
    const b=await import(${JSON.stringify('./' + entries[1].split('/').at(-1))});
    const first=a.getWorkerDeployHighlightJs(),second=b.getWorkerDeployHighlightJs();
    assert.notEqual(first,second);assert.equal(first,a.getWorkerDeployHighlightJs());
    first.registerLanguage('isolated-fixture',()=>({keywords:'hello'}));
    assert.equal(second.getLanguage('isolated-fixture'),undefined);
    assert.ok(first.getLanguage('isolated-fixture'));
    console.log('independent highlighters passed');
  `, { flag: 'wx' });
  const result = run(driver);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout.trim(), 'independent highlighters passed');
});

test('missing split asset permits unused startup and fails explicitly on demand', { timeout: 30000 }, async t => {
  const directory = await mkdtemp('artifacts/core/missing-highlight-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const core = await readFile('artifacts/core/split-native-core.mjs', 'utf8');
  const entry = resolve(directory, 'core.mjs');
  await writeFile(entry, core + `
    init_embedded_agent_runtime();
    const {default:assert}=await import('node:assert/strict');
    for(let i=0;i<2;i++)assert.throws(()=>getWorkerDeployHighlightJs(),{code:'MODULE_NOT_FOUND'});
    console.log('unused startup and explicit failure passed');
  `);
  const result = run(entry);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout.trim(), 'unused startup and explicit failure passed');
});

test('split boundary rejects new consumers and helper dependencies', { timeout: 60000 }, async () => {
  const core = await readFile('artifacts/core/bundled-native-core.mjs', 'utf8');
  assert.throws(() => splitNativeHighlight(core + '\nfunction newConsumer(){return require_python();}\n'), /External highlighter dependency/);
  assert.throws(() => splitNativeHighlight(core + '\nfunction newConsumer(){return require_lib$9();}\n'), /loader consumer boundary changed/);
  assert.throws(() => splitNativeHighlight(core.replace('Zt={exports:{}}', 'Zt={exports:{changed:true}}')), /dependency boundary changed/);
});
