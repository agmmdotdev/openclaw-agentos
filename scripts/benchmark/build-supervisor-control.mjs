// Keep the exact SDK filesystem/tool route but use OpenClaw's original
// supervisor. This is a benchmark control, not a new SDK execution backend.
import {readFile,writeFile} from 'node:fs/promises';
const original='supervisor.spawn = hybrid.spawn;';
const replacement=`const upstreamSpawn = supervisor.spawn.bind(supervisor);
supervisor.spawn = async spec => {
  if (spec.backendId !== 'exec-sandbox' || spec.argv?.[0] !== 'native-sdk-shell') throw new Error('Unexpected supervisor-control route');
  hybrid.counts.shell++;
  return upstreamSpawn({ ...spec, argv: ['sh', '-c', spec.argv[2]], cwd: spec.argv[1], stdinMode: 'pipe-closed' });
};`;
for(const [input,output] of [['native-sdk-core-benchmark.mjs','native-sdk-supervised-benchmark.mjs'],['native-sdk-probe.mjs','native-sdk-supervised-probe.mjs']]){
 const source=await readFile('artifacts/core/'+input,'utf8');
 if(source.split(original).length!==2)throw new Error('Supervisor control insertion boundary changed');
 await writeFile('artifacts/core/'+output,source.replace(original,replacement));
}
