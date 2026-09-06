import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, writeFile, readFile, mkdir, symlink, link, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
const helper = fileURLToPath(new URL('../dist/linux-file-access', import.meta.url));
const launcher = fileURLToPath(new URL('../dist/linux-launcher-experimental', import.meta.url));
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'agentos-openat2-'));
  const root = join(parent, 'workspace'), outside = join(parent, 'outside');
  await mkdir(root); await mkdir(outside);
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  t.after(async () => { await handle.close(); await rm(parent, { recursive: true, force: true }); });
  function call(op, path, input = '', limit = 1024) {
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [op, path, String(limit)], { stdio: ['pipe', 'pipe', 'pipe', handle.fd], env: {} });
      const out = [], err = [];
      child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
      child.on('error', reject); child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); });
      child.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
      child.stdin.end(input);
    });
  }
  return { root, outside, parent, call };
}
test('openat2 read/write/stat use the pinned directory descriptor after root rename', async t => {
  const { root, parent, call } = await fixture(t);
  assert.equal((await call('write', 'hello', 'hello 🐈')).code, 0);
  await rename(root, join(parent, 'moved')); await mkdir(root);
  await writeFile(join(root, 'hello'), 'wrong root');
  assert.equal((await call('read', 'hello')).stdout, 'hello 🐈');
  assert.equal(JSON.parse((await call('stat', 'hello')).stdout).directory, false);
  assert.equal(JSON.parse((await call('stat', '.')).stdout).directory, true);
});
test('openat2 rejects traversal, absolute paths and every symlink component', async t => {
  const { root, outside, call } = await fixture(t);
  await writeFile(join(outside, 'secret'), 'secret'); await writeFile(join(root, 'own'), 'own');
  await symlink(outside, join(root, 'escape')); await symlink('own', join(root, 'internal'));
  await symlink('/proc/self/fd/0', join(root, 'magic'));
  for (const path of ['../outside/secret', '/etc/passwd', 'escape/secret', 'internal', 'magic']) {
    for (const op of ['read', 'write', 'stat']) assert.notEqual((await call(op, path, 'bad')).code, 0, `${op} ${path}`);
  }
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'secret');
  assert.equal(await readFile(join(root, 'own'), 'utf8'), 'own');
});
test('special files and hardlinks cannot be read or truncated by file helper', async t => {
  const { root, outside, call } = await fixture(t);
  await writeFile(join(outside, 'secret'), 'secret'); await link(join(outside, 'secret'), join(root, 'hardlink'));
  assert.equal(spawnSync('mkfifo', [join(root, 'fifo')]).status, 0);
  for (const path of ['hardlink', 'fifo', '.']) for (const op of ['read', 'write']) {
    assert.notEqual((await call(op, path, 'bad')).code, 0);
  }
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'secret');
});
test('bounded file operations reject excess data without publishing partial reads or truncating on excess input', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('write', 'file', '12345', 5)).code, 0);
  const read = await call('read', 'file', '', 4);
  assert.notEqual(read.code, 0); assert.equal(read.stdout, '');
  assert.notEqual((await call('write', 'file', 'abcdef', 5)).code, 0);
  assert.equal((await call('read', 'file')).stdout, '12345');
  assert.notEqual((await call('read', 'file', '', 0)).code, 0);
});
test('concurrent directory/symlink replacement cannot redirect helper reads or writes outside root', async t => {
  const { root, outside, call } = await fixture(t);
  await mkdir(join(root, 'slot')); await writeFile(join(root, 'slot', 'file'), 'inside');
  await writeFile(join(outside, 'file'), 'outside-secret');
  const state = new SharedArrayBuffer(8), flags = new Int32Array(state);
  const worker = new Worker(`
    const {workerData, parentPort} = require('node:worker_threads');
    const fs = require('node:fs');
    const {root, outside, state} = workerData, flags = new Int32Array(state);
    parentPort.postMessage('ready');
    while (!Atomics.load(flags, 0)) {
      fs.renameSync(root + '/slot', root + '/held');
      fs.symlinkSync(outside, root + '/slot');
      fs.unlinkSync(root + '/slot'); fs.renameSync(root + '/held', root + '/slot');
      Atomics.add(flags, 1, 1);
    }
  `, { eval: true, workerData: { root, outside, state } });
  const done = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try {
    for (let i = 0; i < 100; i++) {
      const read = await call('read', 'slot/file');
      if (!read.code) assert.ok(['inside', 'written'].includes(read.stdout));
      else assert.ok([2, 11, 18, 40].includes(JSON.parse(read.stderr).errno), read.stderr);
      const write = await call('write', 'slot/file', 'written');
      if (write.code) assert.ok([2, 11, 18, 40].includes(JSON.parse(write.stderr).errno), write.stderr);
    }
  } finally { Atomics.store(flags, 0, 1); await done; }
  assert.ok(Atomics.load(flags, 1) > 0);
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'outside-secret');
});
test('fixed seccomp self-test installs a filter and checks denied and permitted calls', () => {
  const result = spawnSync(launcher, ['--self-test-seccomp'], { encoding: 'utf8', timeout: 5000, env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).seccompInstalled, true);
  assert.equal(JSON.parse(result.stdout).sandboxVerified, false);
});
test('actual syscall filter permits native Node files, threads and child processes (no Landlock/cgroup claim)', async t => {
  const { root, parent } = await fixture(t);
  const binary = join(parent, 'trusted-seccomp-probe');
  const source = fileURLToPath(new URL('./fixtures/seccomp-node.c', import.meta.url));
  const compile = spawnSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const script = `
    const assert=require('assert/strict'), fs=require('fs');
    fs.writeFileSync('file','hello'); assert.equal(fs.readFileSync('file','utf8'),'hello');
    const child=require('child_process').spawnSync(process.execPath,['-e','console.log("child-ok");process.exitCode=7'],{encoding:'utf8'});
    assert.equal(child.status,7,JSON.stringify({error:child.error,stderr:child.stderr}));assert.equal(child.stdout.trim(),'child-ok');
    const worker=new (require('worker_threads').Worker)('require("worker_threads").parentPort.postMessage("thread-ok")',{eval:true});
    worker.on('message',value=>{assert.equal(value,'thread-ok');console.log('node-filter-ok')});
  `;
  const result = spawnSync(binary, [process.execPath, '-e', script], { encoding: 'utf8', cwd: root, env: {}, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes('node-filter-ok'));
});
test('incomplete launcher enforcement fails before executing payload', async t => {
  const { root } = await fixture(t), marker = join(root, 'should-not-exist');
  const result = spawnSync(launcher, ['--workspace', root, '--cgroup', root,
    '--memory', '268435456', '--pids', '64', '--cpu', '20000 100000',
    '--runtime-file', process.execPath, '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
    { encoding: 'utf8', timeout: 5000, env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  assert.equal(result.status, 125, result.stderr);
  assert.ok(!result.output[3]?.includes('restricted-before-exec'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
