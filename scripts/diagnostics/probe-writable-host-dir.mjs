import { AgentOs, createHostDirBackend } from '@rivet-dev/agentos-core';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only disposable, self-created fixture directories are mounted or targeted.
const root = await mkdtemp(join(tmpdir(), 'core-writable-mount-'));
const reports = [];
try {
  for (const backend of ['chunked_local', 'host_dir']) {
    const directory = join(root, backend);
    await mkdir(directory);
    const hostPath = join(directory, 'workspace');
    await mkdir(hostPath, { mode: backend === 'host_dir' ? 0o777 : 0o700 });
    const outside = join(directory, 'outside');
    await writeFile(outside, 'host-only-marker');
    if (backend === 'host_dir') {
      await symlink(outside, join(hostPath, 'absolute-escape'));
      await symlink('../outside', join(hostPath, 'relative-escape'));
    }
    const mount = { path: '/workspace', plugin: backend === 'host_dir'
      ? createHostDirBackend({ hostPath, readOnly: false })
      : { id: 'chunked_local', config: { metadataPath: join(directory, 'metadata.sqlite'), blockRoot: join(directory, 'blocks') } } };
    const options = {
      sidecar: { kind: 'shared', pool: `writable-mount-${randomUUID()}` },
      mounts: [mount], user: { uid: 1000, gid: 1000 }, allowedNodeBuiltins: ['fs'],
      permissions: { fs: 'allow', process: 'allow', childProcess: 'allow', network: 'deny' },
      limits: { resources: { maxFilesystemBytes: 1024 * 1024 } },
    };
    let vm;
    try {
      vm = await AgentOs.create({ ...options, user: { uid: 0, gid: 0 } });
      const setup = backend === 'host_dir' ? { exitCode: 0 } : await vm.process.execFile('node', ['-e', "const fs=require('fs');fs.chownSync('/workspace',1000,1000);fs.chmodSync('/workspace',0o700)"], { output: { capture: 'all' } });
      if (setup.exitCode !== 0) throw new Error(JSON.stringify(setup));
      await vm.dispose();
      vm = await AgentOs.create(options);
      const code = `const fs=require('fs');
        const checks={uid:process.getuid()};
        if(${JSON.stringify(backend)}==='chunked_local'){
          for(const [target,name] of [[${JSON.stringify(outside)},'absolute-escape'],['../outside','relative-escape']]){
            try{fs.symlinkSync(target,'/workspace/'+name)}catch(e){checks[name+'CreationError']=String(e)}
          }
        }
        fs.writeFileSync('/workspace/file','before');
        fs.renameSync('/workspace/file','/workspace/renamed');
        fs.appendFileSync('/workspace/renamed','-after');
        checks.readWriteRename=fs.readFileSync('/workspace/renamed','utf8')==='before-after';
        fs.symlinkSync('renamed','/workspace/inside');
        checks.internalSymlink=fs.readFileSync('/workspace/inside','utf8')==='before-after';
        for(const name of ['absolute-escape','relative-escape']){
          try{checks[name]=fs.readFileSync('/workspace/'+name,'utf8')!=='host-only-marker'}catch(e){checks[name]=true;checks[name+'Error']=String(e)}
          try{fs.writeFileSync('/workspace/'+name,'mutated')}catch(e){}
        }
        const fd=fs.openSync('/workspace/renamed','r+');fs.fsyncSync(fd);fs.closeSync(fd);
        checks.fsync=true;
        try{fs.writeFileSync('/workspace/over-limit',Buffer.alloc(2*1024*1024));checks.quotaRejected=false}
        catch(e){checks.quotaRejected=true;checks.quotaError=String(e)}
        console.log(JSON.stringify(checks));`;
      const result = await vm.process.execFile('node', ['-e', code], { output: { capture: 'all' }, timeoutMs: 30000 });
      if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
      const checks = JSON.parse(result.stdout);
      checks.outsideUnchanged = await readFile(outside, 'utf8') === 'host-only-marker';
      await vm.dispose();
      vm = await AgentOs.create(options);
      const restored = await vm.process.execFile('node', ['-e', "const fs=require('fs');if(fs.readFileSync('/workspace/renamed','utf8')!=='before-after')throw Error('Persistence failed')"], { output: { capture: 'all' } });
      checks.restored = restored.exitCode === 0;
      reports.push({ backend, hostSeededEscapes: backend === 'host_dir', checks, restored });
    } catch (error) { reports.push({ backend, error: error.stack }); }
    finally { await vm?.dispose(); await vm?.sidecar.dispose(); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
const report = { recordedAt: new Date().toISOString(), agentos: '0.2.19', scope: 'Disposable fixture probe; not a proof of hostile-tenant containment or crash durability', reports };
await mkdir('artifacts/results', { recursive: true });
await writeFile('artifacts/results/writable-host-dir-probe.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (reports.some(report => report.error || ['readWriteRename','internalSymlink','absolute-escape','relative-escape','fsync','outsideUnchanged','restored'].some(key => !report.checks[key]))) process.exitCode = 1;
