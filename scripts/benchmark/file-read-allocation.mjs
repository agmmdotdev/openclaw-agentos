// Diagnostic allocation counts, measured separately from lifecycle benchmarks.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const baselineCommit='7bc2a119761111f071a007650cf0bbd58b204d3c';
if (!process.env.FILE_READ_VARIANT) {
 const { transform }=await import('esbuild');
 const source=execFileSync('git',['show',`${baselineCommit}:packages/agentos-sdk/src/filesystem.ts`],{encoding:'utf8'});
 const compiled=(await transform(source,{loader:'ts',format:'esm',target:'node24'})).code;
 await writeFile('packages/agentos-sdk/dist/filesystem-before.js',compiled);
 const runs=[];
 for(let trial=0;trial<3;trial++)for(const variant of trial%2?['after','before']:['before','after']){
  runs.push(JSON.parse(execFileSync(process.execPath,['--max-semi-space-size=8',import.meta.filename],{env:{...process.env,FILE_READ_VARIANT:variant},encoding:'utf8'})));
 }
 const report={baselineCommit,method:'Instrument Buffer allocation/copy requests for the adapter only; not a process peak measurement; three serial rotated trials per version',sourceHashes:{before:createHash('sha256').update(source).digest('hex'),after:createHash('sha256').update(await readFile('packages/agentos-sdk/src/filesystem.ts')).digest('hex')},runs};
 await writeFile('artifacts/results/file-read-allocation.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
} else {
 const variant=process.env.FILE_READ_VARIANT;
 const {createFileApi}=await import(`../../packages/agentos-sdk/dist/${variant==='before'?'filesystem-before':'filesystem'}.js`);
 const dir=await mkdtemp(join(tmpdir(),'file-read-allocation-'));
 const api=createFileApi(dir,()=>{},2**20);const cases=[];
 try {
  for(const [size,iterations] of [[4096,1000],[65536,500],[1048576,100]]){
   const bytes=Buffer.alloc(size,42);await writeFile(join(dir,'data'),bytes);
   let allocated=0,concatenated=0;const alloc=Buffer.alloc,unsafe=Buffer.allocUnsafe,concat=Buffer.concat;
   Buffer.alloc=function(n,...rest){allocated+=n;return alloc(n,...rest);};
   Buffer.allocUnsafe=function(n,...rest){allocated+=n;return unsafe(n,...rest);};
   Buffer.concat=function(list,total){concatenated+=total??list.reduce((n,b)=>n+b.length,0);return concat(list,total);};
   const before=process.cpuUsage(),start=performance.now();
   try {for(let i=0;i<iterations;i++){const value=await api.readFile('data');if(!Buffer.from(value.buffer,value.byteOffset,value.byteLength).equals(bytes))throw new Error('Bytes differ');}}
   finally {Buffer.alloc=alloc;Buffer.allocUnsafe=unsafe;Buffer.concat=concat;}
   const cpu=process.cpuUsage(before);cases.push({size,iterations,allocatedBytes:allocated,concatenatedBytes:concatenated,wallMs:performance.now()-start,cpuMs:(cpu.user+cpu.system)/1000});
  }
 } finally {await rm(dir,{recursive:true,force:true});}
 console.log(JSON.stringify({variant,cases}));
}
