import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertRequestRuntime } from '../scripts/core/request-profile-guard.mjs';

test('request runtime guard rejects each unsupported host dimension', () => {
  const host = { version: 'v24.19.0', platform: 'linux', arch: 'x64' };
  assert.doesNotThrow(() => assertRequestRuntime(host));
  for (const override of [{ version: 'v24.18.0' }, { version: 'v25.0.0' }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    assert.throws(() => assertRequestRuntime({ ...host, ...override }), /requires revalidation/);
  }
});

test('single-start launcher preserves argv, environment, stdin and exit status from a spaced path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'request launcher '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'core'));
  await cp('scripts/run-core-node-request.sh', join(root, 'launch.sh'));
  await cp('scripts/core/request-profile-guard.mjs', join(root, 'core/request-profile-guard.mjs'));
  await writeFile(join(root, 'entry.mjs'), `
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2),['space argument','--literal','မြန်မာ 🐈']);
    assert.equal(process.cwd(),${JSON.stringify(root)});
    for(const [key,value] of Object.entries({MALLOC_ARENA_MAX:'1',MALLOC_TRIM_THRESHOLD_:'65536',MALLOC_MMAP_THRESHOLD_:'65536'}))assert.equal(process.env[key],value);
    assert.ok(process.execArgv.includes('--liftoff-only'));
    assert.ok(process.execArgv.includes('--max-semi-space-size=8'));
    let input='';for await(const chunk of process.stdin)input+=chunk;
    assert.equal(input,'stdin 🐈');console.log('stdout passed');console.error('stderr passed');process.exitCode=7;
  `);
  const env = { ...process.env, MALLOC_ARENA_MAX: '5' };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE']) delete env[key];
  const result = spawnSync('sh', [join(root, 'launch.sh'), join(root, 'entry.mjs'), 'space argument', '--literal', 'မြန်မာ 🐈'], { cwd: root, env, input: 'stdin 🐈', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 7, result.stderr || String(result.error));
  assert.equal(result.stdout, 'stdout passed\n');
  assert.equal(result.stderr, 'stderr passed\n');
});

test('single-start launcher supports evaluation and propagates a preload failure before entry', () => {
  const script = resolve('scripts/run-core-node-request.sh');
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE']) delete env[key];
  let result = spawnSync('sh', [script, '--eval', 'console.log("eval passed")'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'eval passed\n');
  result = spawnSync('sh', [script, '--import', 'data:text/javascript,throw new Error("preload-stop")', '--eval', 'console.log("must not run")'], { env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /preload-stop/);
});
