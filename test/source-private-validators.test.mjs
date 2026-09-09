import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const core = fileURLToPath(new URL('../packages/openclaw-core/', import.meta.url));
const upstream = join(core, 'upstream/src');
const owners = new Map([
  [join(upstream, 'agents/sessions/model-registry.ts'), 'models'],
  [join(upstream, 'agents/modes/interactive/theme/theme.ts'), 'theme'],
]);

// Instrument only the real schema constructors/compilers; preserve their inputs,
// return values, and errors. Both module import and in-memory use must stay cold.
test('private model/theme validators initialize on parsing and retain validation behavior', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-private-validators-'));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = join(temp, 'state');
  globalThis.__privateValidatorDemand = {};
  try {
    const packageRequire = createRequire(await realpath(join(core, '../../node_modules/openclaw/package.json')));
    const output = join(temp, 'validators.mjs');
    await build({
      stdin: { contents: [
        `import ${JSON.stringify(join(upstream, 'worker/worker-deploy-runtime.ts'))};`,
        `export { ModelRegistry } from ${JSON.stringify(join(upstream, 'agents/sessions/model-registry.ts'))};`,
        `export { AuthStorage } from ${JSON.stringify(join(upstream, 'agents/sessions/auth-storage.ts'))};`,
        `export { Theme, loadThemeFromPath, getLanguageFromPath } from ${JSON.stringify(join(upstream, 'agents/modes/interactive/theme/theme.ts'))};`,
      ].join('\n'), resolveDir: core, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      minify: process.env.CORE_MINIFY === '1', keepNames: process.env.CORE_MINIFY === '1',
      nodePaths: [join(core, 'node_modules'), ...packageRequire.resolve.paths('dependency')],
      loader: { '.sql': 'text' },
      define: { WORKER_DEPLOY_BUILD: 'true', WORKER_DEPLOY_VERSION: '"2026.8.1"' },
      banner: { js: `import {createRequire as __validatorCreateRequire} from 'node:module'; const require=__validatorCreateRequire(${JSON.stringify(join(core, 'package.json'))});` },
      plugins: [{ name: 'private-validator-demand', setup(builder) {
        builder.onLoad({ filter: /(?:model-registry|theme)\.ts$/ }, async ({ path }) => {
          const owner = owners.get(path);
          if (!owner) return;
          let contents = await readFile(path, 'utf8');
          assert.ok(contents.includes('import { Compile } from "typebox/compile";'));
          contents = contents.replace('import { Compile } from "typebox/compile";', 'import { Compile as realCompile } from "typebox/compile";');
          contents = contents.replaceAll('Type.Object(', 'observeObject(');
          contents += `\nfunction demand(kind) { const counts = globalThis.__privateValidatorDemand[${JSON.stringify(owner)}] ??= {schema: 0, compile: 0}; counts[kind]++; }\nfunction observeObject(...args) { demand('schema'); return Type.Object(...args); }\nfunction Compile(...args) { demand('compile'); return realCompile(...args); }\n`;
          return { contents, loader: 'ts' };
        });
      } }],
    });
    const m = await import(pathToFileURL(output));
    assert.deepEqual(globalThis.__privateValidatorDemand, {});
    const empty = m.ModelRegistry.inMemory(m.AuthStorage.inMemory({}));
    assert.deepEqual(empty.getAll(), []);
    assert.equal(empty.getError(), undefined);
    assert.equal(m.getLanguageFromPath('example.ts'), 'typescript');
    assert.deepEqual(globalThis.__privateValidatorDemand, {});

    const catalogPath = join(temp, 'models.json');
    const createRegistry = contents => m.ModelRegistry.create(m.AuthStorage.inMemory({}), catalogPath, {
      includePluginCatalogs: false, modelsJsonContents: JSON.stringify(contents),
    });
    const valid = { providers: { 'test-provider': { api: 'test-api', baseUrl: 'https://example.invalid',
      compat: { supportsStore: true }, models: [{ id: 'test-model', input: ['text', 'audio'],
        maxTokens: 128, compat: { supportsDeveloperRole: true } }] } } };
    const registry = createRegistry(valid);
    assert.equal(registry.getError(), undefined);
    const model = registry.find('test-provider', 'test-model');
    assert.deepEqual(model.input, ['text']);
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 128);
    assert.equal(model.maxTokensSource, 'configured');
    assert.deepEqual(model.compat, { supportsStore: true, supportsDeveloperRole: true });
    assert.equal(globalThis.__privateValidatorDemand.models.compile, 1);
    assert.ok(globalThis.__privateValidatorDemand.models.schema > 0);
    assert.equal(globalThis.__privateValidatorDemand.theme, undefined);
    const modelDemand = { ...globalThis.__privateValidatorDemand.models };
    assert.match(createRegistry({ providers: { broken: { models: [{ id: 42 }] } } }).getError(), /Invalid models\.json schema:[\s\S]*providers\.broken\.models\.0\.id/);
    assert.match(createRegistry({ providers: { broken: { models: [{ id: 'test-model' }] } } }).getError(), /baseUrl.*required/);
    registry.refresh();
    assert.equal(registry.find('test-provider', 'test-model').maxTokens, 128);
    assert.deepEqual(globalThis.__privateValidatorDemand.models, modelDemand);

    const colors = Object.fromEntries((
      'accent border borderAccent borderMuted success error warning muted dim text thinkingText ' +
      'selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel ' +
      'toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode ' +
      'mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved ' +
      'toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber ' +
      'syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium ' +
      'thinkingHigh thinkingXhigh bashMode'
    ).split(' ').map(token => [token, 'primary']));
    const themePath = join(temp, 'theme.json');
    await writeFile(themePath, JSON.stringify({ name: 'test-theme', vars: { primary: '#123456' }, colors }));
    const theme = m.loadThemeFromPath(themePath, 'truecolor');
    assert.ok(theme instanceof m.Theme);
    assert.equal(theme.name, 'test-theme');
    assert.equal(theme.fg('accent', 'hello'), '\x1b[38;2;18;52;86mhello\x1b[39m');
    assert.equal(theme.bg('selectedBg', 'hello'), '\x1b[48;2;18;52;86mhello\x1b[49m');
    assert.equal(globalThis.__privateValidatorDemand.theme.compile, 1);
    assert.ok(globalThis.__privateValidatorDemand.theme.schema > 0);
    const themeDemand = { ...globalThis.__privateValidatorDemand.theme };
    const { accent, border, ...missingColors } = colors;
    await writeFile(themePath, JSON.stringify({ name: 'invalid-theme', colors: missingColors }));
    assert.throws(() => m.loadThemeFromPath(themePath), /Missing required color tokens:\n  - accent\n  - border/);
    await writeFile(themePath, JSON.stringify({ name: 'invalid-theme', colors: { ...colors, accent: 256 } }));
    assert.throws(() => m.loadThemeFromPath(themePath), /Invalid theme/);
    await writeFile(themePath, '{');
    assert.throws(() => m.loadThemeFromPath(themePath), /Failed to parse theme/);
    await writeFile(themePath, JSON.stringify({ name: 'circular-theme', vars: { primary: 'primary' }, colors }));
    assert.throws(() => m.loadThemeFromPath(themePath), /Circular variable reference/);
    assert.deepEqual(globalThis.__privateValidatorDemand.theme, themeDemand);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    delete globalThis.__privateValidatorDemand;
    await rm(temp, { recursive: true, force: true });
  }
});
