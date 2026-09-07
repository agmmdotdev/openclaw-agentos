import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentOs } from '../packages/agentos-sdk/dist/native-entry.js';
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const { createAgentOsToolRuntime } = await import(`../packages/openclaw-core/dist/${prefix}sdk-tool-runtime.mjs`);

async function fixture(t, filesystemBackend) {
  const root = await fs.mkdtemp(join(tmpdir(), 'source-filesystem-'));
  const vm = await AgentOs.create({ backend: 'native-node', security: 'trusted-only', workspaceDir: root, filesystemBackend, maxFileBytes: 131072 });
  const runtime = createAgentOsToolRuntime(vm);
  t.after(async () => { try { await runtime.supervisor.shutdown(); } finally { await vm.dispose(); await fs.rm(root, { recursive: true, force: true }); } });
  return { root, vm, bridge: runtime.sandbox.fsBridge };
}

for (const backend of ['node', 'linux-openat2']) {
  test(`${backend} bridge honors bounds, encoding, parent creation, stat and mutations`, async t => {
    const { root, vm, bridge } = await fixture(t, backend);
    assert.deepEqual(bridge.resolvePath({ filePath: 'file', cwd: join(root, 'nested') }), { containerPath: join(root, 'nested/file'), relativePath: 'nested/file' });
    assert.equal(await bridge.stat({ filePath: 'missing' }), null);
    await bridge.writeFile({ filePath: 'nested/file', data: '00ff80', encoding: 'hex' });
    assert.deepEqual(await bridge.readFile({ filePath: 'nested/file', maxBytes: 3 }), Buffer.from([0, 255, 128]));
    await assert.rejects(bridge.readFile({ filePath: 'nested/file', maxBytes: 2 }), { code: 'FILE_SIZE_LIMIT' });
    for (const maxBytes of [-1, 1.5, Infinity, NaN]) await assert.rejects(bridge.readFile({ filePath: 'nested/file', maxBytes }), { code: 'INVALID_OPTION' });
    await bridge.writeFile({ filePath: 'empty', data: '' });
    assert.equal((await bridge.readFile({ filePath: 'empty', maxBytes: 0 })).length, 0);
    await assert.rejects(bridge.readFile({ filePath: 'nested/file', maxBytes: 0 }), { code: 'FILE_SIZE_LIMIT' });
    await fs.writeFile(join(root, 'oversize'), Buffer.alloc(131073));
    await assert.rejects(bridge.readFile({ filePath: 'oversize', maxBytes: 999999 }), { code: 'FILE_SIZE_LIMIT' });
    await assert.rejects(bridge.writeFile({ filePath: 'no-parent/file', data: 'no', mkdir: false }), { code: 'ENOENT' });
    assert.equal(await bridge.stat({ filePath: 'no-parent' }), null);
    await bridge.rename({ from: 'file', to: 'moved', cwd: join(root, 'nested') });
    assert.equal(await bridge.stat({ filePath: 'nested/file' }), null);
    const stat = await bridge.stat({ filePath: 'nested/moved' });
    assert.equal(stat.type, 'file'); assert.equal(stat.size, 3); assert.ok(stat.mtimeMs > 0);
    await assert.rejects(bridge.remove({ filePath: 'nested', force: true }), { code: 'ENOTEMPTY' });
    await bridge.remove({ filePath: 'nested', recursive: true });
    await bridge.remove({ filePath: 'nested', force: true });
    await assert.rejects(bridge.remove({ filePath: 'nested' }), { code: 'ENOENT' });
    await assert.rejects(bridge.remove({ filePath: '.', recursive: true, force: true }));
    await assert.rejects(bridge.rename({ from: 'empty', to: '../escaped' }), /Outside workspace/);
    await assert.rejects(bridge.writeFile({ filePath: '../escaped', data: 'no' }), /Outside workspace/);
    await fs.symlink('/tmp', join(root, 'outside-link'));
    await assert.rejects(bridge.stat({ filePath: 'outside-link' }));
    await assert.rejects(bridge.remove({ filePath: 'outside-link/absent', force: true }));
    // A Buffer returned by the SDK is already owned by this read: no second full-file copy.
    const original = vm.filesystem.readFile;
    let delivered;
    vm.filesystem.readFile = async (...args) => (delivered = await original(...args));
    const received = await bridge.readFile({ filePath: 'empty' });
    assert.equal(received, delivered);
  });

  test(`${backend} exclusive creation has one winner and never overwrites existing entries`, async t => {
    const { root, bridge } = await fixture(t, backend);
    const outcomes = await Promise.all(['first', 'second', 'third'].map(data => bridge.createFileExclusive({ filePath: 'race', data })));
    assert.equal(outcomes.filter(x => x === 'created').length, 1);
    assert.equal(outcomes.filter(x => x === 'exists').length, 2);
    assert.equal(await fs.readFile(join(root, 'race'), 'utf8'), ['first', 'second', 'third'][outcomes.indexOf('created')]);
    assert.equal(await bridge.createFileExclusive({ filePath: 'race', data: 'overwrite' }), 'exists');
    await bridge.mkdirp({ filePath: 'directory' });
    assert.equal(await bridge.createFileExclusive({ filePath: 'directory', data: 'overwrite' }), 'exists');
    await fs.symlink('race', join(root, 'link'));
    assert.equal(await bridge.createFileExclusive({ filePath: 'link', data: 'overwrite' }), 'exists');
    assert.equal(await bridge.createFileExclusive({ filePath: 'new/deep/file', data: 'မြန်မာ 🐈' }), 'created');
    assert.equal((await bridge.readFile({ filePath: 'new/deep/file' })).toString(), 'မြန်မာ 🐈');
    assert.equal(await fs.readFile(join(root, 'race'), 'utf8'), ['first', 'second', 'third'][outcomes.indexOf('created')]);
    await assert.rejects(bridge.createFileExclusive({ filePath: 'oversized-create', data: Buffer.alloc(131073) }), { code: 'FILE_SIZE_LIMIT' });
    assert.equal(await bridge.stat({ filePath: 'oversized-create' }), null);
    assert.equal(bridge.copyFile, undefined);
  });

  test(`${backend} cancellation preserves reasons, prevents pre-aborted mutations and releases listeners`, async t => {
    const { root, vm, bridge } = await fixture(t, backend);
    await bridge.writeFile({ filePath: 'keep', data: 'original' });
    const reason = Object.assign(new Error('cancelled by caller'), { code: 'ENOENT' });
    const signal = AbortSignal.abort(reason);
    for (const action of [
      () => bridge.readFile({ filePath: 'keep', signal }),
      () => bridge.writeFile({ filePath: 'keep', data: 'overwrite', signal }),
      () => bridge.createFileExclusive({ filePath: 'new/file', data: 'no', signal }),
      () => bridge.mkdirp({ filePath: 'new', signal }),
      () => bridge.stat({ filePath: 'keep', signal }),
      () => bridge.rename({ from: 'keep', to: 'moved', signal }),
      () => bridge.remove({ filePath: 'keep', force: true, signal }),
    ]) await assert.rejects(action(), error => error === reason);
    assert.equal(await fs.readFile(join(root, 'keep'), 'utf8'), 'original');
    assert.equal(await bridge.stat({ filePath: 'new' }), null);
    const path = backend === 'node' ? join(root, 'keep') : 'keep';
    for (const reason of [new Error('in-flight abort'), null, false, 0]) {
      const controller = new AbortController();
      const pending = vm.filesystem.readFile(path, { signal: controller.signal });
      const rejected = assert.rejects(pending, error => error === reason);
      controller.abort(reason);
      await rejected;
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
    const controller = new AbortController();
    assert.equal(Buffer.from(await vm.filesystem.readFile(path, { signal: controller.signal })).toString(), 'original');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('Node bounded reader detects real file growth after its initial stat and closes the descriptor', async t => {
  const { root, bridge } = await fixture(t, 'node');
  await bridge.writeFile({ filePath: 'growing', data: '12' });
  const originalOpen = fs.open;
  let reads = 0, closed = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== join(root, 'growing')) return handle;
    const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
    handle.read = async (...args) => {
      // Use real descriptor reads; inject growth only after the reader's fstat.
      if (++reads === 1) await fs.appendFile(join(root, 'growing'), '345');
      return originalRead(...args);
    };
    handle.close = async () => { closed = true; return originalClose(); };
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(bridge.readFile({ filePath: 'growing', maxBytes: 3 }), { code: 'FILE_SIZE_LIMIT' }); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  assert.ok(reads > 0); assert.equal(closed, true);
});

test('Node special files are classified correctly and rejected without blocking', { timeout: 3000 }, async t => {
  const { root, bridge } = await fixture(t, 'node');
  await promisify(execFile)('mkfifo', [join(root, 'fifo')]);
  assert.equal((await bridge.stat({ filePath: 'fifo' })).type, 'other');
  await assert.rejects(bridge.readFile({ filePath: 'fifo' }), { code: 'INVALID_FILE' });
  await assert.rejects(bridge.writeFile({ filePath: 'fifo', data: 'no' }), error => ['ENXIO', 'INVALID_FILE'].includes(error.code));
});
