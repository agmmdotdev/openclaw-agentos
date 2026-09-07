// Isolated, real-parser throughput. Run separately from lifecycle comparisons.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const trial = process.argv[2];
if (!/^\d+$/.test(trial ?? '')) throw new Error('Usage: node scripts/benchmark/parser-throughput.mjs TRIAL');
const core = await readFile('artifacts/core/native-core.mjs', 'utf8');
const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(core) !== manifest.nativeCoreSha256) throw new Error('Core differs from manifest');
const corpus = [
  'printf "%s" "$value" | sed -n "1,4p"',
  'for file in src/*.ts; do if test -f "$file"; then printf "%s\\n" "$file"; fi; done',
  'cat <<\'END\'\ntext $not_expanded\nEND\n',
  'diff <(printf "%s" "$(pwd)") <(echo "${value:-default}")',
  'for x in a b; do echo "$x" | sort; done\n'.repeat(100),
];
const fixture = `
init_embedded_agent_runtime();
const __throughputCorpus=${JSON.stringify(corpus)};
async function __parseChecked(command) {
  const tree=await parseBashForCommandExplanation(command);
  try { if(tree.rootNode.hasError)throw new Error('Unexpected parse error');return tree.rootNode.namedChildCount; }
  finally { tree.delete(); }
}
const __coldStart=performance.now();await __parseChecked(__throughputCorpus[0]);const __coldMs=performance.now()-__coldStart;
for(let i=0;i<100;i++)await __parseChecked(__throughputCorpus[i%__throughputCorpus.length]);
await new Promise(resolve=>setTimeout(resolve,1000));
let __checksum=0;const __warmStart=performance.now(),__cpuStart=process.cpuUsage();
for(let i=0;i<1000;i++)__checksum+=await __parseChecked(__throughputCorpus[i%__throughputCorpus.length]);
const __warmCpu=process.cpuUsage(__cpuStart);
console.log(JSON.stringify({node:process.version,v8:process.versions.v8,coldParseMs:__coldMs,warmParseMs:performance.now()-__warmStart,warmCpuMs:(__warmCpu.user+__warmCpu.system)/1000,parses:1000,checksum:__checksum}));
`;
const entry = `artifacts/core/parser-throughput-${trial}.mjs`;
await writeFile(entry, core + fixture, { flag: 'wx' });
const runs = [];
try {
  for (let repeat = 0; repeat < 3; repeat++) for (const profile of (repeat % 2 ? ['request', 'default'] : ['default', 'request'])) {
    const env = { ...process.env, MALLOC_ARENA_MAX: '1', MALLOC_TRIM_THRESHOLD_: '65536', MALLOC_MMAP_THRESHOLD_: '65536' };
    for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'LD_PRELOAD']) delete env[key];
    const args = profile === 'request' ? ['scripts/run-core-node-request.mjs', entry] : ['--max-semi-space-size=8', entry];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0 || result.stderr) throw new Error(result.stderr || String(result.error));
    runs.push({ repeat, profile, ...JSON.parse(result.stdout) });
  }
  if (new Set(runs.map(run => run.checksum)).size !== 1) throw new Error('Parser workload diverged');
  await writeFile(`artifacts/results/parser-throughput-${trial}.json`, JSON.stringify({ coreSha256: hash(core), fixtureSha256: hash(fixture), corpus, method: 'Three serial rotated trials. 100 warmup parses plus 1 second pause, then 1,000 checked parses across five scripts. No scripted inference or forced GC. Timing/CPU covers the warm parse loop only; not a full core benchmark.', runs }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(runs));
} finally { await rm(entry, { force: true }); }
