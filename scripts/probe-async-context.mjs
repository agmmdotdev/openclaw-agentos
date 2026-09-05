import { AgentOs } from '@rivet-dev/agentos-core';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const code = `const {AsyncLocalStorage}=require('node:async_hooks');
(async()=>{for(const delays of [[5],[5,20],[20,5]]){
  const storage=new AsyncLocalStorage();
  const results=await Promise.all(delays.map((ms,i)=>storage.run('context-'+i,async()=>{
    await new Promise(resolve=>setTimeout(resolve,ms));return storage.getStore();
  })));
  console.log(JSON.stringify({delays,results,after:storage.getStore()}));
}})();`;
const nodeOutput = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 });
const vm = await AgentOs.create();
try {
  const result = await vm.process.execFile('node', ['-e', code], { timeoutMs: 10000, output: { capture: 'all' } });
  const report = { node: process.version, agentos: '0.2.19', nodeOutput, agentosResult: result, matchesNode: result.exitCode === 0 && result.stdout === nodeOutput };
  await mkdir('artifacts/results', { recursive: true });
  await writeFile('artifacts/results/async-context.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.matchesNode) process.exitCode = 1;
} finally { await vm.dispose(); }
