import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('request profile preserves real Bash parser trees, spans, errors and size limit', { timeout: 60000 }, async t => {
  const core = await readFile('artifacts/core/native-core.mjs', 'utf8');
  const manifest = JSON.parse(await readFile('artifacts/core/manifest.json', 'utf8'));
  assert.equal(createHash('sha256').update(core).digest('hex'), manifest.nativeCoreSha256);
  const corpus = [
    '', 'echo hello', "printf '%s\\n' 'hello world'", 'cat a | sort -u > result.txt',
    'echo "$(printf inner)"; echo `pwd`', 'A=1 B="two words" node app.cjs --flag',
    'if test -f config; then cat config; else exit 7; fi',
    'for x in a b; do echo "$x"; done', 'f() { local x=1; echo "$x"; }; f',
    'cat <<\'END\'\nnot $expanded\nEND\n', '(echo child) && { echo parent; }',
    'echo ok 2>&1 | tee out; false || echo fallback', 'echo မြန်မာ 🐈',
    '# comment\r\nprintf done\r\n', 'printf "%s" "unterminated', 'if then fi',
    'diff <(echo a) <(echo b)', 'echo "${value:-default}" $((1 + 2))',
    'echo x\n'.repeat(1500),
  ];
  const entry = `artifacts/core/parser-contract-${process.pid}.mjs`;
  t.after(() => rm(entry, { force: true }));
  const fixture = `
init_embedded_agent_runtime();
const __corpus=${JSON.stringify(corpus)}, __trees=[];
for(const command of __corpus) {
  const tree=await parseBashForCommandExplanation(command);
  try {
    function visit(n){return [n.type,n.startIndex,n.endIndex,n.startPosition,n.endPosition,n.hasError,n.children.map(visit)];}
    __trees.push(visit(tree.rootNode));
  } finally { tree.delete(); }
}
let __oversize=false;
try { await parseBashForCommandExplanation('x'.repeat(128*1024+1)); }
catch(e) { if(!e.message.includes('too large'))throw e;__oversize=true; }
if(!__oversize)throw new Error('Oversized command accepted');
console.log(JSON.stringify({trees:__trees,oversize:__oversize}));
`;
  await writeFile(entry, core + fixture, { flag: 'wx' });
  const results = [];
  for (const profile of ['default', 'request']) {
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'LD_PRELOAD']) delete env[key];
    const args = profile === 'request' ? ['scripts/run-core-node-request.mjs', entry] : ['--max-semi-space-size=8', entry];
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 25000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stderr, '', 'Parser must not silently fall back');
    results.push(JSON.parse(result.stdout));
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].trees.length, corpus.length);
  assert.equal(results[0].trees[14][5], true, 'Malformed input must retain its parse error');
});
