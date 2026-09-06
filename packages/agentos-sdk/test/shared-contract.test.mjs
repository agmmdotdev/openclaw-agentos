import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentOs} from '../dist/index.js';
for(const backend of ['native-node','agentos'])test(`shared extracted contract: ${backend}`,{timeout:45000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-contract-'));
 const vm=backend==='native-node'?await AgentOs.create({backend,workspaceDir:root,security:'trusted-only'}):await AgentOs.create({backend,options:{sidecar:{kind:'shared',pool:randomUUID()},mounts:[{path:'/workspace',plugin:{id:'chunked_local',config:{metadataPath:join(root,'fs.sqlite'),blockRoot:join(root,'blocks'),uid:1000,gid:1000,dirMode:0o700,fileMode:0o600}}}],permissions:{fs:'allow',process:'allow',childProcess:'allow',env:'allow',network:'deny',binding:'deny'}}});
 t.after(async()=>{await vm.dispose();if(backend==='agentos')await vm.sidecar.dispose();await rm(root,{recursive:true,force:true});});
 const cwd=backend==='native-node'?root:'/workspace';
 await vm.filesystem.mkdir(cwd+'/dir');await vm.filesystem.writeFile(cwd+'/dir/seed.txt','shared 🐈\n');
 assert.equal(Buffer.from(await vm.filesystem.readFile(cwd+'/dir/seed.txt')).toString(),'shared 🐈\n');
 assert.equal((await vm.filesystem.stat(cwd+'/dir')).isDirectory,true);
 assert.deepEqual(await vm.filesystem.readdir(cwd+'/dir'),['seed.txt']);
 const chunks=[],errs=[];const p=await vm.process.spawn('sh',['-c','cat seed.txt; printf error >&2; exit 7'],{cwd:cwd+'/dir',onStdout:b=>chunks.push(Buffer.from(b)),onStderr:b=>errs.push(Buffer.from(b)),output:{retainEvents:false}});
 const e=await vm.process.wait(p.pid);assert.equal(e.outcome,'exited');assert.equal(e.exitCode,7);assert.equal(Buffer.concat(chunks).toString(),'shared 🐈\n');assert.equal(Buffer.concat(errs).toString(),'error');
 const result=await vm.process.execFile('node',['-e','console.log("native-contract")'],{cwd,output:{capture:'all'}});assert.equal(result.outcome,'succeeded');assert.equal(result.stdout.trim(),'native-contract');
 assert.equal((await vm.process.exec('echo uncaptured',{cwd})).stdout,undefined);
 await t.test('stdin EOF: native completes; pinned upstream cat limitation recorded',async()=>{
  const result=await vm.process.exec('cat',{cwd,stdin:'input 🐈\n',output:{capture:'all'},timeoutMs:3000});
  if(backend==='agentos') {
   t.diagnostic('Known upstream 0.2.19 cat/stdin EOF limitation: '+JSON.stringify(result));
   assert.equal(result.outcome,'timed_out');
  } else {assert.equal(result.outcome,'succeeded');assert.equal(result.stdout,'input 🐈\n');}
 });
 await t.test('stderr-only capture, environment and argument boundaries',async()=>{
  const result=await vm.process.execFile('sh',['-c','printf "%s" "$VALUE"; printf "%s" "$1" >&2','fixture','argument with spaces'],{cwd,env:{VALUE:'value with spaces'},output:{capture:'stderr'}});
  assert.equal(result.outcome,'succeeded');assert.equal(result.stdout,undefined);assert.equal(result.stderr,'argument with spaces');
 });
 await t.test('timeout result settles',async()=>{
  const result=await vm.process.exec('sleep 10',{cwd,timeoutMs:100});assert.equal(result.outcome,'timed_out');
 });
 await t.test('ESM file resolves relative imports',async()=>{
  await vm.filesystem.writeFile(cwd+'/dep.mjs','export const answer=42');
  await vm.filesystem.writeFile(cwd+'/entry.mjs',"import {answer} from './dep.mjs';console.log(answer)");
  const result=await vm.javascript.executeFile(cwd+'/entry.mjs',{cwd,output:{capture:'all'}});
  assert.equal(result.outcome,'succeeded');assert.equal(result.stdout.trim(),'42');
 });
 await vm.filesystem.move(cwd+'/dir/seed.txt',cwd+'/moved.txt');await vm.filesystem.remove(cwd+'/dir');assert.equal(await vm.filesystem.exists(cwd+'/dir'),false);
});
