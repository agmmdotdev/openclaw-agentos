import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOs } from '../packages/agentos-sdk/dist/native-entry.js';
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const { createAgentOsToolRuntime } = await import(`../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs`);

async function fixture(t, filesystemBackend = 'node') {
  const root = await mkdtemp(join(tmpdir(), 'source-sdk-runtime-'));

  await mkdir(join(root, 'workspace'));
  await symlink(join(root, 'workspace'), join(root, 'alias'));
  const vm = await AgentOs.create({ backend: 'native-node', security: 'trusted-only',
    workspaceDir: join(root, 'alias'), filesystemBackend });

  const runtime = createAgentOsToolRuntime(vm);
  t.after(async () => {try {await runtime.supervisor.shutdown();} finally {await vm.dispose();await rm(root,{recursive:true,force:true});}});
  const spawn = async (command, options = {}) => runtime.supervisor.spawn({
    mode: 'child', backendId: 'exec-sandbox', timeoutMs: 2000,
    ...await runtime.sandbox.backend.buildExecSpec({ command, workdir: vm.workspaceDir, env: {}, usePty: false }),
    ...options,
  });
  return { vm, runtime, spawn };
}

for (const backend of ['node', 'linux-openat2']) {
  test(`owned SDK bridge uses canonical paths and real ${backend} file operations`, async t => {
    const { vm, runtime } = await fixture(t, backend);
    const fs = runtime.sandbox.fsBridge;
    assert.equal(runtime.sandbox.workspaceDir, vm.workspaceDir);
    await fs.mkdirp({ filePath: 'nested' });
    await fs.writeFile({ filePath: 'input.txt', cwd: join(vm.workspaceDir, 'nested'), data: 'မြန်မာ 🐈' });
    assert.equal((await fs.readFile({ filePath: 'nested/input.txt' })).toString(), 'မြန်မာ 🐈');
    assert.equal((await fs.stat({ filePath: 'nested' })).type, 'directory');
    assert.equal((await fs.stat({ filePath: 'nested/input.txt' })).type, 'file');
    await assert.rejects(fs.readFile({ filePath: '../outside' }), /Outside workspace/);
    await assert.rejects(runtime.sandbox.backend.validateWorkdir(join(vm.workspaceDir, 'nested/input.txt')), /Invalid cwd/);
    await assert.rejects(runtime.sandbox.backend.buildExecSpec({ usePty: true }), /PTY unsupported/);
    await assert.rejects(runtime.supervisor.spawn({ backendId: 'exec-host', argv: ['sh'] }), /Unexpected execution route/);
    assert.equal(vm.capabilities.sandboxed, false);
  });
}

test('SDK stdin callback completes and propagates write errors, with real EOF and exit output', { timeout: 5000 }, async t => {
  const { vm, spawn } = await fixture(t);
  let stdout = '', stderr = '';
  const run = await spawn('cat; printf "stderr 🐈" >&2; exit 7', {
    onStdout: text => { stdout += text; }, onStderr: text => { stderr += text; },
  });
  const input = Buffer.from('မြန်မာ 🐈');
  for (const byte of input) {
    await new Promise((resolve, reject) => run.stdin.write(Buffer.from([byte]), error => error ? reject(error) : resolve()));
  }
  await run.stdin.end();
  const exit = await run.wait();
  assert.equal(exit.exitCode, 7);
  assert.equal(exit.reason, 'exit');
  assert.equal(exit.timedOut, false);
  assert.equal(stdout, input.toString());
  assert.equal(stderr, 'stderr 🐈');
  await assert.rejects(new Promise((resolve, reject) => run.stdin.write('late', error => error ? reject(error) : resolve())), /stdin is not writable/);
  // The bridge borrows its handle; the caller remains responsible for teardown.
  await vm.filesystem.writeFile('still-open', 'owned by caller');
});

test('SDK deadlines and explicit cancellation use OpenClaw termination reasons', { timeout: 5000 }, async t => {
  const { spawn } = await fixture(t);
  const deadline = await spawn('sleep 10', { timeoutMs: 30 });
  assert.equal((await deadline.wait()).reason, 'overall-timeout');
  assert.equal((await deadline.wait()).timedOut, true);
  for (const reason of [undefined, 'overall-timeout', 'no-output-timeout']) {
    const run = await spawn('sleep 10');
    run.cancel(reason);
    const exit = await run.wait();
    assert.equal(exit.reason, reason ?? 'manual-cancel');
    assert.equal(exit.timedOut, reason !== undefined);
    assert.equal(exit.noOutputTimedOut, reason === 'no-output-timeout');
  }
});
