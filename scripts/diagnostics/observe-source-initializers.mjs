import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// Diagnostic copy only: label esbuild's module callbacks without changing the
// runtime artifact. Nested initialization is subtracted from exclusive time.
const input = process.argv[2];
if (!input || !input.endsWith('.mjs')) throw new Error('Usage: node scripts/diagnostics/observe-source-initializers.mjs UNMINIFIED_CORE.mjs');
let source = await readFile(input, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
for (const helper of ['__esm', '__commonJS']) {
  const declaration = `var ${helper} = `;
  if (source.split(declaration).length !== 2) throw new Error(`Expected one ${helper} helper; build without minification`);
  source = source.replace(declaration, `var __original${helper} = `);
}
const boundary = 'var __export = ';
if (source.split(boundary).length !== 2) throw new Error('Module helper boundary changed');
const observation = `
const __initializers = globalThis.__sourceInitializerObservations = { inputSha256: ${JSON.stringify(sha256)}, rows: [] };
const __initializerStack = [];
function __observeInitializer(callbacks) {
  const module = Object.getOwnPropertyNames(callbacks)[0];
  const callback = callbacks[module];
  return {[module](...args) {
    const frame = {childrenMs: 0, start: performance.now()};
    __initializerStack.push(frame);
    try { return callback.apply(this, args); } finally {
      const inclusiveMs = performance.now() - frame.start;
      __initializerStack.pop();
      if (__initializerStack.length) __initializerStack.at(-1).childrenMs += inclusiveMs;
      __initializers.rows.push({module, inclusiveMs, selfMs: inclusiveMs - frame.childrenMs});
    }
  }};
}
var __esm = (fn, ...args) => __original__esm(__observeInitializer(fn), ...args);
var __commonJS = (fn, ...args) => __original__commonJS(__observeInitializer(fn), ...args);
`;
// The input source map describes the uninstrumented code and must not be used
// to attribute this diagnostic copy. Module callback names supply the labels.
source = source.replace(boundary, observation + boundary).replace(/^\/\/# sourceMappingURL=.*$/m, '');
const output = join(dirname(input), `observed-${basename(input)}`);
await writeFile(output, source);
console.log(output);
