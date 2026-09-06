import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentOs,inspectLinuxCapabilities} from '../dist/index.js';
async function fixture(t,extra={}){
 const root=await mkdtemp(join(tmpdir(),'agentos-native-test-'));
 const vm=await AgentOs.create({backend:'native-node',workspaceDir:root,security:'trusted-only',...extra});
 t.after(async()=>{await vm.dispose();await rm(root,{recursive:true,force:true});});return {vm,root};
}
test('protected mode fails before creating workspace; never falls back',async()=>{
 await assert.rejects(AgentOs.create({backend:'native-node',workspaceDir:'/does-not-exist',security:'linux-sandbox'}),e=>e.code==='SANDBOX_UNAVAILABLE'&&e.details.launcherImplemented===false);
 const c=await inspectLinuxCapabilities();assert.equal(c.sandboxEnforcementVerified,false);
});
test('unknown options and implicit trust are rejected',async()=>{
 await assert.rejects(AgentOs.create({backend:'native-node',workspaceDir:'/tmp',security:'trusted-only',permissions:{network:'deny'}}),{code:'UNSUPPORTED_OPTION'});
 await assert.rejects(AgentOs.create({backend:'native-node',workspaceDir:'/tmp'}),{code:'SANDBOX_UNAVAILABLE'});
});
test('filesystem CRUD, batches, metadata, recursive listings and persistence',async t=>{
 const {vm,root}=await fixture(t);
 await vm.filesystem.mkdir('a/b',{recursive:true});await vm.filesystem.writeFile('a/b/f','hello 🐈');
 assert.equal(Buffer.from(await vm.filesystem.readFile('a/b/f')).toString(),'hello 🐈');
 assert.equal((await vm.filesystem.stat('a')).isDirectory,true);
 assert.equal((await vm.filesystem.stat('a/b/f')).isDirectory,false);
 assert.deepEqual(await vm.filesystem.readdir('a'),['b']);
 assert.equal((await vm.filesystem.readdirEntries('a'))[0].isDirectory,true);
 assert.equal((await vm.filesystem.readdirRecursive('a')).length,2);
 assert.equal((await vm.filesystem.readFiles(['a/b/f','missing']))[1].content,null);
 assert.equal((await vm.filesystem.writeFiles([{path:'x',content:'persist'}]))[0].success,true);
 await vm.filesystem.move('a/b/f','moved');await vm.filesystem.remove('a',{recursive:true});
 assert.equal(await vm.filesystem.exists('a'),false);await vm.dispose();assert.equal(await readFile(join(root,'x'),'utf8'),'persist');
 await assert.rejects(vm.filesystem.readFile('x'),{code:'DISPOSED'});
});
test('direct traversal and symlink outside workspace rejected (not a race-proof sandbox test)',async t=>{
 const {vm,root}=await fixture(t);const outside=await mkdtemp(join(tmpdir(),'agentos-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await writeFile(join(outside,'secret'),'secret');await symlink(outside,join(root,'link'));
 await assert.rejects(vm.filesystem.readFile('../outside'),{code:'OUTSIDE_WORKSPACE'});
 await assert.rejects(vm.filesystem.readFile('link/secret'),{code:'OUTSIDE_WORKSPACE'});
 await assert.rejects(vm.filesystem.writeFile('link/new','bad'),{code:'OUTSIDE_WORKSPACE'});
 await assert.rejects(vm.filesystem.remove(root),{code:'INVALID_PATH'});
});
test('native process argv, cwd, environment, stdin, Unicode output, exit and replay',async t=>{
 const {vm,root}=await fixture(t);const chunks=[];
 const p=await vm.process.spawn(process.execPath,['-e',"process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>{console.error(process.env.TEST_VALUE);process.exitCode=7})"],{env:{TEST_VALUE:'ok'},onStdout:b=>chunks.push(b)});
 const waiting=vm.process.wait(p.pid);await vm.process.writeStdin(p.pid,'hi 🐈');await vm.process.closeStdin(p.pid);
 const exit=await waiting;assert.equal(exit.outcome,'exited');assert.equal(exit.exitCode,7);assert.equal(Buffer.concat(chunks).toString(),'hi 🐈');
 const replay=await vm.process.readOutput(p.pid);assert.ok(replay.events.length);assert.equal((await vm.process.get(p.pid)).state,'exited');
 assert.equal((await vm.process.execFile(process.execPath,['-e','console.log(process.cwd())'],{output:{capture:'all'}})).stdout.trim(),root);
 assert.equal((await vm.process.exec('printf hello',{output:{capture:'all'}})).stdout,'hello');
});
test('nonzero, missing executable, capture modes and invalid options',async t=>{
 const {vm}=await fixture(t);
 assert.equal((await vm.process.exec('exit 7')).outcome,'failed');
 await assert.rejects(vm.process.spawn('nonexistent-agentos-executable-xyz'),{code:'ENOENT'});
 const none=await vm.process.exec('echo output',{output:{capture:'none'}});assert.equal(none.stdout,undefined);
 await assert.rejects(vm.process.spawn('sh',[],{pty:{}}),{code:'UNSUPPORTED_OPTION'});
 await assert.rejects(vm.process.exec('true',{contextId:'persistent'}),{code:'UNSUPPORTED_OPTION'});
});
test('timeout and AbortSignal terminate commands',async t=>{
 const {vm}=await fixture(t);
 const started=performance.now();const r=await vm.process.exec('sleep 10',{timeoutMs:100});assert.equal(r.outcome,'timed_out');assert.ok(performance.now()-started<2000);
 const abort=new AbortController();const p=await vm.process.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:abort.signal});const done=vm.process.wait(p.pid);abort.abort();assert.equal((await done).outcome,'signalled');
 await assert.rejects(vm.process.spawn('sh',[],{signal:abort.signal}),{code:'ABORTED'});
});
test('output and input bounds; callback failure cannot crash the host',async t=>{
 const {vm}=await fixture(t,{outputLimitBytes:4096});
 const r=await vm.process.execFile(process.execPath,['-e','process.stdout.write("x".repeat(1000000))'],{output:{capture:'all'}});assert.equal(r.error.code,'OUTPUT_LIMIT');assert.ok(Buffer.byteLength(r.stdout)<=4096);
 const failed=await vm.process.exec('echo hi',{onStdout(){throw new Error('consumer failed');}});assert.equal(failed.error.code,'OUTPUT_CALLBACK_ERROR');
 const p=await vm.process.spawn('cat');await assert.rejects(vm.process.writeStdin(p.pid,'x'.repeat(4097)),{code:'STDIN_LIMIT'});await vm.process.kill(p.pid);await vm.process.wait(p.pid);
});
test('managed admission limits, bounded history and stale handles',async t=>{
 const {vm}=await fixture(t,{managedProcessLimit:1,retainedProcessLimit:2});
 const p=await vm.process.spawn('sleep',['10']);await assert.rejects(vm.process.spawn('true'),{code:'MANAGED_PROCESS_LIMIT'});await vm.process.kill(p.pid);await vm.process.wait(p.pid);
 for(let i=0;i<8;i++)assert.equal((await vm.process.exec('true')).outcome,'succeeded');
 assert.equal((await vm.process.list()).length,2);await assert.rejects(vm.process.kill(p.pid),{code:'PROCESS_NOT_FOUND'});
});
test('dispose racing with spawn settles and never launches after disposal',async t=>{
 const {vm}=await fixture(t);const pending=vm.process.spawn('sleep',['10']);const disposed=vm.dispose();
 const [a,b]=await Promise.allSettled([pending,disposed]);assert.equal(b.status,'fulfilled');if(a.status==='rejected')assert.equal(a.reason.code,'DISPOSED');
 await vm.dispose();await assert.rejects(vm.process.spawn('true'),{code:'DISPOSED'});
});
test('same-process-group descendants are stopped when shell exits',async t=>{
 const {vm}=await fixture(t);const start=performance.now();const r=await vm.process.exec('sleep 10 & echo done',{output:{capture:'all'}});assert.equal(r.outcome,'succeeded');assert.match(r.stdout,/done/);assert.ok(performance.now()-start<2000);
});
test('JavaScript module, CommonJS and file execution use native Node',async t=>{
 const {vm}=await fixture(t);await vm.filesystem.writeFile('task.mjs','console.log(process.version)');
 assert.equal((await vm.javascript.executeFile('task.mjs',{output:{capture:'all'}})).stdout.trim(),process.version);
 assert.equal((await vm.javascript.execute('console.log(typeof require)',{format:'commonjs',output:{capture:'all'}})).stdout.trim(),'function');
 assert.equal((await vm.javascript.execute('import fs from "node:fs"; console.log(typeof fs.readFile)',{output:{capture:'all'}})).stdout.trim(),'function');
});
test('20 create/run/dispose lifecycles leave no managed children; files reopen',async t=>{
 const root=await mkdtemp(join(tmpdir(),'agentos-lifecycle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let prior='';for(let i=0;i<20;i++){
  const vm=await AgentOs.create({backend:'native-node',workspaceDir:root,security:'trusted-only'});
  if(i)assert.equal(Buffer.from(await vm.filesystem.readFile('state')).toString(),prior);
  prior=String(i);await vm.filesystem.writeFile('state',prior);
  const p=await vm.process.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);const hostPid=p.hostPid;
  await vm.dispose();assert.throws(()=>process.kill(hostPid,0),{code:'ESRCH'});
 }
});
test('unsupported SDK surfaces fail explicitly',async t=>{
 const {vm}=await fixture(t);
 for(const get of [()=>vm.sessions,()=>vm.filesystem.mount,()=>vm.javascript.evaluate,()=>vm.process.resizePty,()=>vm.typescript])assert.throws(get,{code:'UNSUPPORTED_CAPABILITY'});
 await assert.rejects(vm.process.exec('true',{output:{retainEvents:true}}),{code:'UNSUPPORTED_OPTION'});
});
test('oversized initial stdin is rejected before a child launches',async t=>{
 const {vm}=await fixture(t,{outputLimitBytes:32});
 await assert.rejects(vm.process.spawn('cat',[],{stdin:'x'.repeat(33)}),{code:'STDIN_LIMIT'});
 await assert.rejects(vm.process.exec('cat',{stdin:'x'.repeat(33)}),{code:'STDIN_LIMIT'});
 assert.deepEqual(await vm.process.list(),[]);
});
