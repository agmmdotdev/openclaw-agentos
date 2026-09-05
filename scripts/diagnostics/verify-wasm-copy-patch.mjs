// Tests a proposed upstream patch against the pinned source in a temporary
// file. Never changes the installed sidecar or its bundled runner.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import ts from 'typescript';

const [sourcePath, wasmPath] = process.argv.slice(2);
if (!sourcePath || !wasmPath) throw new Error('Usage: node --expose-gc scripts/diagnostics/verify-wasm-copy-patch.mjs <v0.2.19 wasm-runner.mjs> <published sh binary>');
const source = await readFile(sourcePath, 'utf8');
const wasm = await readFile(wasmPath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(source), 'ccc7468514a8f99151ca4226617b85a48c44ff6b9cb3674b931af8d911ae9e4d');
assert.equal(hash(wasm), 'afe65bc64a0c698291d110f18218862efda7bdee4484a94248d9f749e06de961');
const temp = await mkdtemp('/tmp/wasm-copy-proof-');
try {
  const outputPath = join(temp, 'patched.mjs');
  const patch = spawnSync('patch', ['--batch', '--output', outputPath, sourcePath, 'patches/agentos-wasm-memory-copy.patch'], { encoding: 'utf8' });
  assert.equal(patch.status, 0, patch.stderr + patch.stdout);
  const patched = await readFile(outputPath, 'utf8');
  function load(text) {
    const ast = ts.createSourceFile('runner.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = ['readVarUint', 'encodeVarUint', 'appendBytes', 'rewriteMemorySection', 'enforceMemoryLimit'];
    const bodies = names.map(name => {
      const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.equal(matches.length, 1, name);
      return matches[0].getText(ast);
    });
    return new Function('Buffer', 'const WASM_PAGE_BYTES=65536;\n' + bodies.join('\n') + '\nreturn enforceMemoryLimit;')(Buffer);
  }
  const original = load(source), optimized = load(patched);
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  const leb = n => { const bytes = []; do { let b = n & 127; n = Math.floor(n / 128); if (n) b |= 128; bytes.push(b); } while (n); return bytes; };
  let cases = 0;
  function compare(bytes, limit) {
    const evaluate = fn => { try { return { bytes: Buffer.from(fn(bytes, limit)) }; } catch (error) { return { error: error.message }; } };
    assert.deepEqual(evaluate(optimized), evaluate(original)); cases++;
  }
  for (const bytes of [wasm, Buffer.from(header), Buffer.alloc(0), Buffer.alloc(8), Buffer.from([...header, 5, 99, 1]), Buffer.from([...header, 5, 3, 1, 2, 1])]) {
    for (const limit of [undefined, NaN, 0, 1, 2, 8192]) compare(bytes, limit);
  }
  for (const minimum of [0, 1, 127, 128, 1024]) {
    for (const maximum of [null, minimum, minimum + 1, 8192]) {
      const memory = [1, maximum === null ? 0 : 1, ...leb(minimum), ...(maximum === null ? [] : leb(maximum))];
      const binary = Buffer.from([...header, 5, ...leb(memory.length), ...memory]);
      for (const limit of [0, 1, 127, 128, 1024, 8192]) compare(binary, limit);
    }
  }
  const exportedMemory = Buffer.from([...header, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
  for (const rewrite of [original, optimized]) {
    const { memory } = new WebAssembly.Instance(new WebAssembly.Module(rewrite(exportedMemory, 2))).exports;
    assert.equal(memory.grow(1), 1);
    assert.throws(() => memory.grow(1), RangeError);
  }
  const expected = original(wasm, 8192);
  assert.ok(WebAssembly.validate(expected));
  const runs = [];
  for (const name of ['original', 'optimized', 'optimized', 'original']) {
    const rewrite = name === 'original' ? original : optimized;
    global.gc?.();
    const cpu = process.cpuUsage(), times = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now(); const bytes = rewrite(wasm, 8192);
      times.push(performance.now() - start);
      assert.deepEqual(bytes, expected);
    }
    runs.push({ name, times, cpu: process.cpuUsage(cpu) });
  }
  await mkdir('artifacts/results', { recursive: true });
  await writeFile('artifacts/results/wasm-copy-patch-proof.json', JSON.stringify({
    sourceRevision: '9ae6abbdc48391a75b8336e7832b3e76f42616ee', sourceSha256: hash(source),
    wasmSha256: hash(wasm), inputBytes: wasm.length, differentialCases: cases,
    growthLimitChecksPassed: true, appliedToRuntime: false, node: process.version, runs,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ differentialCases: cases, growthLimitChecksPassed: true, appliedToRuntime: false }));
} finally { await rm(temp, { recursive: true, force: true }); }
