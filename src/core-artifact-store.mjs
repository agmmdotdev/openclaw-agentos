import { createHostDirBackend } from '@rivet-dev/agentos-core';
import { mkdtemp, mkdir, writeFile, rm, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

// Curated code/assets only. Tenant workspace and state retain their durable
// chunked_local mounts. Never mount the project or node_modules wholesale.
export async function createCoreArtifactStore() {
  const directory = await mkdtemp(join(tmpdir(), 'openclaw-core-artifacts-'));
  // host_dir exposes host mode bits to guest uid 1000. mkdtemp's 0700 would
  // let streamed entries load but deny guest fs reads of parser assets.
  await chmod(directory, 0o755);
  let sealed = false;
  function target(path) {
    if (sealed) throw new Error('Core artifact store is sealed');
    if (typeof path !== 'string' || !path.startsWith('/core/') || path.includes('\\')
      || path.includes('\0') || path.slice(6).split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid core artifact path');
    }
    return join(directory, path.slice(6));
  }
  return {
    mount: { path: '/core', plugin: createHostDirBackend({ hostPath: directory, readOnly: true }), readOnly: true },
    filesystem: {
      mkdir: (path, options) => mkdir(target(path), options),
      writeFile: (path, bytes) => writeFile(target(path), bytes, { mode: 0o444, flag: 'wx' }),
      // Prepared artifacts can be copied without allocating another full-size
      // Node Buffer. The source is host-controlled; guests cannot invoke this.
      copyFile: async (source, path) => {
        const destination = target(path);
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, 0o444);
      },
      writeEntry: async (source, path, suffix, expectedSha256) => {
        const destination = target(path);
        const hash = createHash('sha256');
        async function* chunks() {
          for await (const chunk of createReadStream(source)) { hash.update(chunk); yield chunk; }
          if (hash.digest('hex') !== expectedSha256) throw new Error('Unverified core worker artifact');
          yield suffix;
        }
        const sink = createWriteStream(destination, { mode: 0o444, flags: 'wx' });
        let created = false;
        sink.once('open', () => { created = true; });
        try { await pipeline(chunks(), sink); }
        catch (error) { if (created) await rm(destination, { force: true }); throw error; }
      },
    },
    seal() { sealed = true; },
    // Dispose only after every VM using this store has exited.
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
