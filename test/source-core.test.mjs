import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const prefix = process.env.CORE_MINIFY === '1' ? 'minified-' : '';
const diagnostics = new URL(`../packages/openclaw-core/dist/${prefix}diagnostics.mjs`, import.meta.url);

test('source config results match merged core for all 28 existing cases', async () => {
  const fixture = await readFile('test/fixtures/native-lazy-init.mjs', 'utf8');
  const start = fixture.indexOf('const __initConfigs = [');
  const end = fixture.indexOf('const __initValidationResults =', start);
  assert.ok(start >= 0 && end > start);
  const cases = fixture.slice(start, end);
  const probe = `${cases}\nconst before = __sourceTestZ.string().safeParse(42).error.issues; __sourceTestZ.config({localeError:()=> 'custom-locale-preserved'}); const configs = __initConfigs.map(validateConfigObjectRaw); if(__sourceTestZ.string().safeParse(42).error.issues[0].message !== 'custom-locale-preserved') throw Error('Locale was reset'); console.log('RESULT='+JSON.stringify({before,configs}));`;
  const sourceFile = 'artifacts/core/source-config-parity.mjs';
  const referenceFile = 'artifacts/core/reference-config-parity.mjs';
  await writeFile(sourceFile, `import {z as __sourceTestZ,validateConfigObjectRaw} from '../../packages/openclaw-core/dist/${prefix}diagnostics.mjs';\nif (Object.values(globalThis.__sourceCoreInit ?? {}).some(Boolean)) throw Error('Configuration graph initialized eagerly');\n` + probe + `\nif (Object.values(globalThis.__sourceCoreInit ?? {}).length !== 4 || Object.values(globalThis.__sourceCoreInit).some(n=>n!==1)) throw Error('Configuration graph did not initialize exactly once');\n`);
  await writeFile(referenceFile, await readFile('artifacts/core/native-core.mjs','utf8') + '\ninit_embedded_agent_runtime();\nconst __sourceTestZ = {string:string$3,config:config$1};\n' + probe);
  const results = [];
  for (const file of [referenceFile, sourceFile]) {
    const {stdout} = await exec(process.execPath,[file],{maxBuffer:8*1024*1024});
    results.push(JSON.parse(stdout.split('\n').find(l=>l.startsWith('RESULT=')).slice(7)));
  }
  assert.equal(results[0].configs.length,28);
  assert.deepEqual(results[1],results[0]);
});

test('source supervisor routing isolates all operations and revokes retained callbacks', async () => {
  const {withProcessSupervisor,getProcessSupervisor} = await import(diagnostics);
  let retained;
  const operations=['spawn','cancel','cancelScope','getRecord','waitForScope'];
  const routes=await Promise.all(['a','b'].map(name=>withProcessSupervisor(
    Object.fromEntries(operations.map(method=>[method,()=>name])),async()=>{
      await new Promise(resolve=>setImmediate(resolve));
      const supervisor=getProcessSupervisor();
      if(name==='a') retained=supervisor;
      return operations.map(method=>supervisor[method]({}));
    })));
  assert.deepEqual(routes,[Array(5).fill('a'),Array(5).fill('b')]);
  for(const method of operations)assert.throws(()=>retained[method]({}),/runtime is closed/);
  const host=getProcessSupervisor();
  const run=await host.spawn({mode:'child',backendId:'exec-host',sessionId:'source-host-proof',
    argv:[process.execPath,'-e','process.stdout.write("default host")'],stdinMode:'pipe-closed'});
  assert.equal((await run.wait()).stdout,'default host');
  assert.equal(host.getRecord(run.runId).state,'exited');
});

test('source core resumes three separate processes with five real SDK tools each', async () => {
  const root=await mkdtemp(join(tmpdir(),'source-core-'));
  try {
    await mkdir(join(root,'workspace')); await mkdir(join(root,'state'));
    for(let turn=0;turn<3;turn++) {
      const {stdout,stderr}=await exec(process.execPath,[`artifacts/core/${prefix}source-native-sdk-core-benchmark.mjs`],{
        env:{...process.env,BENCH_ROOT:root,BENCH_REQUEST_TURN:String(turn)},maxBuffer:8*1024*1024,
      });
      assert.doesNotMatch(stderr,/failed to asynchronously prepare wasm|Aborted\(/);
      const event=stdout.split('\n').filter(l=>l.startsWith('BENCH_EVENT=')).map(l=>JSON.parse(l.slice(12))).find(e=>e.label==='representative:complete');
      assert.equal(event.nextTurn,turn+1);
      assert.deepEqual(event.toolCounts,{read:1,exec:2,edit:1,write:1});
      assert.equal(event.transcriptMessages,24+(turn+1)*12);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('highlighter demand caches once and explicit replacements cancel pending demand', async () => {
  const m = await import(diagnostics);
  const original = m.getWorkerDeployHighlightJs();
  assert.match(original.highlight('const value = 42;', {language:'javascript'}).value,/hljs/);
  assert.equal(m.getWorkerDeployHighlightJs(),original);
  const other = {json5:m.getWorkerDeployJson5(),resolveSecureTempRoot:m.getWorkerDeploySecureTempRoot()};
  let calls=0;
  m.setWorkerDeployHighlightLoader(()=>{calls++;return original;});
  const custom=()=> 'caller function';
  m.setWorkerDeployRuntime({...other,highlightJs:custom});
  assert.equal(m.getWorkerDeployHighlightJs(),custom);
  assert.equal(calls,0);
  m.setWorkerDeployHighlightLoader(()=>{calls++;return original;});
  m.setWorkerDeployRuntime({...other,highlightJs:undefined});
  assert.equal(m.getWorkerDeployHighlightJs(),undefined);
  assert.equal(calls,0);
  m.setWorkerDeployHighlightLoader(()=>{calls++;return original;});
  assert.equal(m.getWorkerDeployHighlightJs(),original);
  assert.equal(m.getWorkerDeployHighlightJs(),original);
  assert.equal(calls,1);
});
