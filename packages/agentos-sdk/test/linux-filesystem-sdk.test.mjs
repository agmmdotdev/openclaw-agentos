import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rename, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOs } from '../dist/native-entry.js';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentos-sdk-openat2-'));
  const vm = await AgentOs.create({ backend: 'native-node', workspaceDir: root,
    security: 'trusted-only', filesystemBackend: 'linux-openat2', ...options });
  t.after(async () => { await vm.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, vm };
}
test('SDK openat2 file API returns bytes, metadata, batch results and explicit capabilities', async t => {
  const { vm, root } = await fixture(t);
  assert.equal(vm.capabilities.filesystemBackend, 'linux-openat2');
  assert.equal(vm.capabilities.sandboxed, false);
  await vm.filesystem.writeFile('file', 'hello 🐈');
  assert.equal(Buffer.from(await vm.filesystem.readFile('file')).toString(), 'hello 🐈');
  const stat = await vm.filesystem.stat('file');
  assert.equal(stat.size, Buffer.byteLength('hello 🐈')); assert.equal(stat.sizeExact, BigInt(stat.size));
  assert.equal(stat.isDirectory, false); assert.ok(stat.mtimeMs > 0); assert.equal(typeof stat.inoExact, 'bigint');
  assert.equal(await vm.filesystem.exists('missing'), false);
  const result = await vm.filesystem.writeFiles([{ path: 'second', content: new Uint8Array([0, 255]) }]);
  assert.equal(result[0].success, true);
  const batch = await vm.filesystem.readFiles(['second', 'missing']);
  assert.deepEqual([...batch[0].content], [0, 255]); assert.equal(batch[1].content, null);
  await vm.dispose(); assert.equal(await readFile(join(root, 'file'), 'utf8'), 'hello 🐈');
});
test('SDK openat2 selection rejects escapes and workspace-root mutations without fallback', async t => {
  const { vm, root } = await fixture(t);
  await writeFile(join(root, 'own'), 'safe'); await symlink('own', join(root, 'link'));
  await assert.rejects(vm.filesystem.readFile('link'), { code: 'ELOOP' });
  await assert.rejects(vm.filesystem.readFile('../outside'), { code: 'EXDEV' });
  await assert.rejects(vm.filesystem.readFile(join(root, 'own')), { code: 'INVALID_PATH' });
  await assert.rejects(vm.filesystem.remove('.'), { code: 'EINVAL' });
  await assert.rejects(vm.filesystem.move('own', '.'), { code: 'EINVAL' });
  assert.equal(await readFile(join(root, 'own'), 'utf8'), 'safe');
  await assert.rejects(readFile(join(root, 'new')), { code: 'ENOENT' });
});
test('SDK openat2 directory CRUD preserves Unicode names and handles recursion and empty directories', async t => {
  const { vm, root } = await fixture(t);
  await vm.filesystem.mkdir('a/🐈/deep', { recursive: true });
  await vm.filesystem.writeFile('a/🐈/hello\n.txt', 'hello');
  await vm.filesystem.writeFile('a/🐈/deep/file', 'world');
  assert.deepEqual((await vm.filesystem.readdir('a')).sort(), ['🐈']);
  assert.equal((await vm.filesystem.readdirEntries('a'))[0].isDirectory, true);
  assert.equal((await vm.filesystem.readdirRecursive('a', { maxDepth: 0 })).length, 1);
  assert.equal((await vm.filesystem.readdirRecursive('a')).length, 4);
  assert.deepEqual(await vm.filesystem.readdirRecursive('a', { exclude: ['🐈'] }), []);
  await vm.filesystem.move('a/🐈/hello\n.txt', 'a/moved');
  assert.equal(await readFile(join(root, 'a/moved'), 'utf8'), 'hello');
  await assert.rejects(vm.filesystem.remove('a'), { code: 'ENOTEMPTY' });
  await vm.filesystem.remove('a', { recursive: true });
  assert.equal(await vm.filesystem.exists('a'), false);
  await vm.filesystem.mkdir('empty'); await vm.filesystem.remove('empty');
});
test('SDK directory operations never follow final or intermediate symlinks', async t => {
  const { vm, root } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'agentos-directory-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'canary'), 'outside');
  await vm.filesystem.mkdir('tree'); await symlink(outside, join(root, 'tree/link'));
  assert.equal((await vm.filesystem.readdirEntries('tree'))[0].isSymbolicLink, true);
  assert.equal((await vm.filesystem.readdirRecursive('tree'))[0].type, 'symlink');
  await assert.rejects(vm.filesystem.mkdir('tree/link/child'), e => ['ELOOP', 'ENOTDIR'].includes(e.code));
  await assert.rejects(vm.filesystem.move('tree/link/canary', 'bad'), e => ['ELOOP', 'ENOTDIR'].includes(e.code));
  await vm.filesystem.remove('tree', { recursive: true });
  assert.equal(await readFile(join(outside, 'canary'), 'utf8'), 'outside');
});
test('SDK openat2 handle follows pinned workspace identity after a trusted parent rename', async t => {
  const { vm, root } = await fixture(t);
  const moved = root + '-moved'; t.after(() => rm(moved, { recursive: true, force: true }));
  await vm.filesystem.writeFile('file', 'original');
  await rename(root, moved); await mkdir(root); await writeFile(join(root, 'file'), 'replacement');
  assert.equal(Buffer.from(await vm.filesystem.readFile('file')).toString(), 'original');
  await vm.filesystem.writeFile('file', 'updated');
  assert.equal(await readFile(join(moved, 'file'), 'utf8'), 'updated');
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'replacement');
});
test('SDK openat2 enforces file, aggregate batch and active-helper limits', async t => {
  const { vm } = await fixture(t, { maxFileBytes: 4 });
  await vm.filesystem.writeFile('file', '1234');
  await assert.rejects(vm.filesystem.writeFile('file', '12345'), { code: 'FILE_SIZE_LIMIT' });
  assert.equal(Buffer.from(await vm.filesystem.readFile('file')).toString(), '1234');
  const batch = await vm.filesystem.readFiles(['file', 'file']);
  assert.equal(batch[1].content, null); assert.match(batch[1].error, /Batch exceeds/);
  const many = await Promise.allSettled(Array.from({ length: 20 }, () => vm.filesystem.readFile('file')));
  assert.equal(many.filter(x => x.status === 'fulfilled').length, 4);
  assert.ok(many.filter(x => x.status === 'rejected').every(x => x.reason.code === 'FILE_OPERATION_LIMIT'));
});
test('SDK openat2 disposal stops admission and settles in-flight helpers', async t => {
  const { vm } = await fixture(t);
  await vm.filesystem.writeFile('file', 'data');
  const pending = Promise.allSettled(Array.from({ length: 4 }, () => vm.filesystem.readFile('file')));
  const disposal = vm.dispose(); assert.equal(vm.dispose(), disposal);
  await assert.rejects(vm.filesystem.readFile('file'), { code: 'DISPOSED' });
  await disposal;
  assert.ok((await pending).every(x => x.status === 'fulfilled' || x.reason.code === 'DISPOSED'));
});
test('SDK openat2 repeated create/dispose and failed construction close pinned descriptors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentos-sdk-fd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { backend: 'native-node', workspaceDir: root, security: 'trusted-only', filesystemBackend: 'linux-openat2' };
  const before = (await readdir('/proc/self/fd')).length;
  for (let i = 0; i < 20; i++) {
    const vm = await AgentOs.create(options);
    await vm.filesystem.writeFile('persist', String(i)); await vm.dispose();
  }
  await assert.rejects(AgentOs.create({ ...options, managedProcessLimit: 0 }), { code: 'INVALID_OPTION' });
  await assert.rejects(AgentOs.create({ ...options, maxFileBytes: 16777217 }), { code: 'INVALID_OPTION' });
  await assert.rejects(AgentOs.create({ ...options, security: 'linux-sandbox' }), { code: 'SANDBOX_UNAVAILABLE' });
  assert.equal((await readdir('/proc/self/fd')).length, before);
  assert.equal(await readFile(join(root, 'persist'), 'utf8'), '19');
});
