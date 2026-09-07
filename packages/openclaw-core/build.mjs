import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const packageRequire = createRequire(await realpath(join(root, '../../node_modules/openclaw/package.json')));
const nodePaths = [join(root, 'node_modules'), ...packageRequire.resolve.paths('dependency')];
await mkdir(join(root, 'dist'), { recursive: true });
const entry = process.env.CORE_DIAGNOSTICS === '1' ? 'diagnostics' : 'index';
const minified = process.env.CORE_MINIFY === '1';
const outputEntry = `${minified ? 'minified-' : ''}${entry}`;
const result = await build({
  absWorkingDir: root, entryPoints: [`src/${entry}.ts`], outfile: `dist/${outputEntry}.mjs`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  minify: minified, keepNames: minified,
  metafile: true, sourcemap: true, nodePaths, loader: { '.sql': 'text' },
  plugins: entry === 'diagnostics' ? [{ name: 'initialization-observation', setup(builder) {
    builder.onLoad({filter: /[\\/]config[\\/]zod-schema(?:\.agent-runtime|\.root-support|\.core)?\.ts$/}, async ({path}) => ({
      contents: (await readFile(path, 'utf8')) + `\nglobalThis.__sourceCoreInit ??= {}; globalThis.__sourceCoreInit[${JSON.stringify(path.split('/').at(-1))}] = (globalThis.__sourceCoreInit[${JSON.stringify(path.split('/').at(-1))}] ?? 0) + 1;`,
      loader: 'ts',
    }));
    builder.onLoad({filter: /[\\/](?:zod-schema\.installs|installed-plugin-index-store)\.ts$/}, async ({path}) => {
      const factory = path.endsWith('zod-schema.installs.ts') ? 'createPluginInstallRecordSchema' : 'createInstalledPluginIndexSchema';
      const boundary = `function ${factory}() {`;
      const source = await readFile(path, 'utf8');
      if (source.split(boundary).length !== 2) throw new Error(`Schema factory boundary changed: ${factory}`);
      return {contents: source.replace(boundary, boundary + `\nglobalThis.__sourceInstallSchemaInit ??= {}; globalThis.__sourceInstallSchemaInit.${factory} = (globalThis.__sourceInstallSchemaInit.${factory} ?? 0) + 1;`), loader: 'ts'};
    });
  }}] : [],
  define: { WORKER_DEPLOY_BUILD: 'true', WORKER_DEPLOY_VERSION: '"2026.8.1"' },
  banner: { js: 'import { createRequire as __coreCreateRequire } from "node:module"; const require = __coreCreateRequire(import.meta.url);' },
});
await writeFile(join(root, `dist/${outputEntry}.metafile.json`), JSON.stringify(result.metafile, null, 2) + '\n');
const output = await readFile(join(root, `dist/${outputEntry}.mjs`));
await writeFile(join(root, `dist/${outputEntry}.manifest.json`), JSON.stringify({ upstreamCommit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b', sourceBuilt: true, minified, keepNames: minified, bytes: output.length, sha256: createHash('sha256').update(output).digest('hex') }, null, 2) + '\n');
console.log(`Source core built: ${output.length} bytes`);

for (const [from, to] of [
  [join(dirname(packageRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm'), 'web-tree-sitter.wasm'],
  [packageRequire.resolve('tree-sitter-bash/tree-sitter-bash.wasm'), 'node_modules/tree-sitter-bash/tree-sitter-bash.wasm'],
]) {
  await mkdir(dirname(join(root, 'dist', to)), { recursive: true });
  await writeFile(join(root, 'dist', to), await readFile(from));
}
await writeFile(join(root, 'dist/node_modules/tree-sitter-bash/package.json'), JSON.stringify({ name: 'tree-sitter-bash', version: '0.25.1' }));
