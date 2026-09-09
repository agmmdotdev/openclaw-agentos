import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const diagnostics = new URL(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`, import.meta.url);

test('computer parsers compile on demand, cache independently, and keep wire constraints', async () => {
  const m = await import(diagnostics);
  const count = () => globalThis.__sourceComputerCompiles ?? 0;
  assert.equal(count(), 0, 'Computer validators compiled during core import');
  assert.throws(() => m.parseComputerActParamsJSON('{'), /params must be valid JSON/);
  assert.equal(count(), 0);

  // Exported schema mutation must not change the canonical parser's constraints.
  const screenIndex = m.ScreenSnapshotParamsSchema.properties.screenIndex;
  const originalMinimum = screenIndex.minimum;
  screenIndex.minimum = -10;
  try {
    assert.throws(() => m.parseScreenSnapshotParamsJSON('{"screenIndex":-1}'), /invalid params/);
  } finally { screenIndex.minimum = originalMinimum; }
  assert.equal(count(), 1);
  assert.deepEqual(m.parseScreenSnapshotParamsJSON(null), {});
  assert.deepEqual(m.parseScreenSnapshotParamsJSON('{"screenIndex":0,"maxWidth":1}'), {screenIndex: 0, maxWidth: 1});
  for (const value of [{maxWidth: 0}, {screenIndex: 0.5}, {extra: true}, {executionId: 'invalid'}])
    assert.throws(() => m.parseScreenSnapshotParamsJSON(JSON.stringify(value)), /invalid params/);
  assert.equal(count(), 1);

  assert.deepEqual(m.parseComputerActParamsJSON('{"action":"type","text":"hello"}'), {action: 'type', text: 'hello'});
  const browser = {action: 'browser_type', browserRef: 'browser', pageRef: 'page', observationId: 'observation', elementRef: 'element', text: ''};
  assert.deepEqual(m.parseComputerActParamsJSON(JSON.stringify(browser)), browser);
  for (const value of [{action: 'unknown'}, {...browser, observationId: ''}, {...browser, extra: true}, {action: 'left_click', x: -1}])
    assert.throws(() => m.parseComputerActParamsJSON(JSON.stringify(value)), /invalid params/);
  assert.equal(count(), 2);

  const result = {ok: true, observation: {kind: 'window', elements: []}};
  assert.equal(m.parseComputerActResult(result), result);
  for (const value of [{ok: 'yes'}, {ok: true, extra: true}, {ok: true, details: Object.fromEntries(Array.from({length: 65}, (_, i) => [String(i), i]))}])
    assert.throws(() => m.parseComputerActResult(value), /COMPUTER_CONTRACT_MISMATCH/);
  assert.equal(count(), 3);

  const capability = {contractVersion: 2, provider: {id: 'test', label: 'Test', generation: 'one'}, actions: ['screenshot', 'type'], targets: ['screen'], deliveryModes: ['foreground'], observations: ['image'], features: {recording: false, agentCursor: false, multiDisplay: true}};
  assert.equal(m.parseComputerUseCapabilityDescriptor(capability), capability);
  for (const value of [{...capability, contractVersion: 1}, {...capability, actions: ['type', 'type']}, {...capability, targets: ['unknown']}, {...capability, extra: true}])
    assert.throws(() => m.parseComputerUseCapabilityDescriptor(value), /COMPUTER_CONTRACT_MISMATCH/);
  assert.equal(count(), 4);

  const snapshot = {format: 'png', base64: 'data', displayFrameId: '', screenIndex: 0, width: 1, height: 1, capturedAtMs: 0, discarded: true};
  assert.deepEqual(m.parseScreenSnapshotResult(snapshot), {format: 'png', base64: 'data', screenIndex: 0, width: 1, height: 1, capturedAtMs: 0});
  for (const value of [{format: 'gif', base64: 'data'}, {format: 'png', base64: ''}, {...snapshot, capturedAtMs: -1}])
    assert.throws(() => m.parseScreenSnapshotResult(value), /invalid screen.snapshot payload/);
  assert.equal(count(), 5);

  // The public compilation helper keeps its eager contract for caller-owned schemas.
  const validate = m.compileComputerUseValidator(m.ScreenSnapshotParamsSchema);
  assert.equal(count(), 6);
  assert.equal(validate({screenIndex: 0}), true);
  assert.equal(validate({screenIndex: -1}), false);
});

test('real headless requests leave computer, model-file and theme-file validators undemanded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'source-validator-demand-'));
  const entry = `artifacts/core/${prefix}source-validator-demand.mjs`;
  try {
    await mkdir(join(root, 'workspace')); await mkdir(join(root, 'state'));
    const fixture = await readFile(`artifacts/core/${prefix}source-native-sdk-core-benchmark.mjs`, 'utf8');
    const boundary = `/dist/${prefix}index.mjs`;
    assert.equal(fixture.split(boundary).length, 2);
    await writeFile(entry, fixture.replace(boundary, `/dist/${prefix}diagnostics.mjs`) + `
console.log('VALIDATOR_DEMAND=' + JSON.stringify({computerCompiles: globalThis.__sourceComputerCompiles ?? 0, privateSchemas: globalThis.__sourcePrivateSchemaInit ?? {}}));
`);
    const turns = [];
    for (let turn = 0; turn < 3; turn++) {
      const {stdout, stderr} = await promisify(execFile)(process.execPath, [entry], {
        env: {...process.env, BENCH_ROOT: root, BENCH_REQUEST_TURN: String(turn)}, maxBuffer: 8 * 1024 * 1024,
      });
      assert.doesNotMatch(stderr, /failed to asynchronously prepare wasm|Aborted\(/);
      const lines = stdout.split('\n');
      const demand = JSON.parse(lines.find(line => line.startsWith('VALIDATOR_DEMAND=')).slice(17));
      assert.deepEqual(demand, {computerCompiles: 0, privateSchemas: {}});
      const complete = lines.filter(line => line.startsWith('BENCH_EVENT=')).map(line => JSON.parse(line.slice(12))).find(event => event.label === 'representative:complete');
      assert.equal(complete.nextTurn, turn + 1);
      assert.deepEqual(complete.toolCounts, {read: 1, exec: 2, edit: 1, write: 1});
      assert.equal(complete.transcriptMessages, 24 + (turn + 1) * 12);
      turns.push({turn, demand, toolCounts: complete.toolCounts, transcriptMessages: complete.transcriptMessages});
    }
    const manifest = JSON.parse(await readFile(`packages/openclaw-core/dist/${prefix}diagnostics.manifest.json`, 'utf8'));
    await writeFile(`artifacts/results/source-validator-demand-${prefix || 'standard-'}result.json`, JSON.stringify({diagnostic: true, manifest, turns}, null, 2) + '\n');
  } finally {
    await rm(entry, {force: true});
    await rm(root, {recursive: true, force: true});
  }
});
