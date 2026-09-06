import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { beginRequest } from '../scripts/core/request-state.mjs';
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'core-request-')); t.after(() => rm(dir, {recursive:true,force:true})); return dir; }
test('checkpoint resumes in sequence and refuses duplicate/out-of-order turns', async t => {
 const dir=await fixture(t); const first=await beginRequest(dir,0);
 await assert.rejects(beginRequest(dir,0),/active or interrupted/);
 const messages=[{role:'user',content:'persist 🐈'}];await first.commit(messages);
 await assert.rejects(first.commit(messages),/already committed/);
 await assert.rejects(beginRequest(dir,0),/expects turn 1/);
 await assert.rejects(beginRequest(dir,2),/expects turn 1/);
 const second=await beginRequest(dir,1);assert.deepEqual(second.history,messages);await second.commit([...messages,{role:'assistant',content:'done'}]);
 assert.equal(JSON.parse(await readFile(join(dir,'request-checkpoint.json'))).nextTurn,2);
});
test('corrupt and missing checkpoints refuse resume without erasing evidence', async t => {
 const dir=await fixture(t);await assert.rejects(beginRequest(dir,1),/Missing checkpoint/);
 await writeFile(join(dir,'request-checkpoint.json'),'{broken');
 await assert.rejects(beginRequest(dir,0),SyntaxError);
 assert.equal(await readFile(join(dir,'request-checkpoint.json'),'utf8'),'{broken');
 for(const value of [null,false,0,'',[],{}]){
  await writeFile(join(dir,'request-checkpoint.json'),JSON.stringify(value));
  await assert.rejects(beginRequest(dir,0),/Invalid checkpoint/);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'request-checkpoint.json'),'utf8')),value);
 }
});
test('manager SIGKILL preserves an interruption marker and prevents tool replay', {timeout:5000}, async t => {
 const dir=await fixture(t);const module=new URL('../scripts/core/request-state.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {beginRequest} from ${JSON.stringify(module)};await beginRequest(process.argv[1],0);console.log('ready');setInterval(()=>{},1000);`,dir],{stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');const done=once(child,'close');child.kill('SIGKILL');await done;
 await assert.rejects(beginRequest(dir,0),/active or interrupted/);
 assert.equal(JSON.parse(await readFile(join(dir,'request-inflight.json'))).turn,0);
});
