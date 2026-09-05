import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOs } from '@rivet-dev/agentos-core';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCoreArtifactStore } from '../src/core-artifact-store.mjs';

test('shared core mount permits reads and rejects guest mutations, including uid 0', async () => {
  const store = await createCoreArtifactStore();
  const vms = [];
  try {
    for (const path of ['/workspace/escape', '/core/../escape', '/core/a/../../escape', '/core/link\\escape']) {
      assert.throws(() => store.filesystem.writeFile(path, 'bad'), /Invalid core artifact path/);
    }
    await store.filesystem.mkdir('/core/compat', { recursive: true });
    await store.filesystem.writeFile('/core/compat/value.mjs', 'export default "intact";');
    await store.filesystem.writeFile('/core/seed', 'intact');
    const source = join(store.mount.plugin.config.hostPath, 'seed');
    await store.filesystem.copyFile(source, '/core/copy');
    await store.filesystem.writeEntry(source, '/core/entry', '\nsuffix', createHash('sha256').update('intact').digest('hex'));
    await assert.rejects(store.filesystem.writeEntry(source, '/core/rejected', '', 'wrong'), /Unverified core worker/);
    await assert.rejects(readFile(join(store.mount.plugin.config.hostPath, 'rejected')), { code: 'ENOENT' });
    store.seal();
    assert.throws(() => store.filesystem.writeFile('/core/late', 'bad'), /sealed/);
    for (const uid of [1000, 0]) {
      const vm = await AgentOs.create({
        sidecar: { kind: 'shared', pool: `core-mount-test-${randomUUID()}` },
        mounts: [store.mount], user: { uid, gid: uid },
        permissions: { fs: 'allow', process: 'allow', childProcess: 'allow' },
        allowedNodeBuiltins: ['fs'],
      });
      vms.push(vm);
      const source = `import fs from 'node:fs'; import value from '/core/compat/value.mjs';
        if (value !== 'intact' || fs.readFileSync('/core/seed', 'utf8') !== value) throw Error('Read failed');
        if (fs.readFileSync('/core/copy', 'utf8') !== value || fs.readFileSync('/core/entry', 'utf8') !== value + '\\nsuffix') throw Error('Prepared entry differs');
        const mutations = [
          () => fs.writeFileSync('/core/seed', 'bad'), () => fs.appendFileSync('/core/seed', 'bad'),
          () => fs.unlinkSync('/core/seed'), () => fs.renameSync('/core/seed', '/tmp/stolen'),
          () => fs.symlinkSync('/tmp', '/core/link'), () => fs.linkSync('/core/seed', '/tmp/link'),
          () => fs.chmodSync('/core/seed', 0o777), () => fs.truncateSync('/core/seed', 0),
          () => fs.mkdirSync('/core/created'), () => fs.openSync('/core/seed', 'w'),
        ];
        for (const mutate of mutations) {
          let blocked = false;
          try { mutate(); } catch (e) { if (!['EROFS','EXDEV','EPERM','EACCES'].includes(e.code) && !String(e.message).includes('fs.truncate /core/seed: EROFS:')) throw e; blocked = true; }
          if (!blocked) throw Error('Core mutation succeeded');
        }
        if (fs.readFileSync('/core/seed', 'utf8') !== 'intact') throw Error('Mutation changed shared code');
        fs.writeFileSync('/tmp/tenant-data', String(process.getuid()));
        console.log('MOUNT_OK');`;
      // Stream a separate entry; /core itself is read-only after sealing.
      await vm.filesystem.writeFile('/tmp/check.mjs', source);
      const result = await vm.process.execFile('node', ['/tmp/check.mjs'], { output: { capture: 'all' } });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.stdout.trim(), 'MOUNT_OK');
    }
    for (let index = 0; index < vms.length; index++) {
      assert.equal((await vms[index].filesystem.readFile('/tmp/tenant-data')).toString('utf8'), String(index === 0 ? 1000 : 0));
    }
    assert.equal(await readFile(join(store.mount.plugin.config.hostPath, 'seed'), 'utf8'), 'intact');
  } finally {
    for (const vm of vms) { await vm.dispose(); await vm.sidecar.dispose(); }
    await store.dispose();
  }
});
