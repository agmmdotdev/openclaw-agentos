import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const core = join(repo, 'packages/openclaw-core');
const upstream = join(core, 'upstream/src');
const baselineCommit = '8c5a633a62f1251871e1f3651ea1e1cc336ca874';
const originalOwners = new Set([
  ...['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'render-utils'].map(name => `agents/sessions/tools/${name}.ts`),
  'agents/modes/interactive/components/keybinding-hints.ts',
  'agents/modes/interactive/components/visual-truncate.ts',
  'agents/modes/interactive/theme/theme.ts',
]);
const colorTokens = (
  'accent border borderAccent borderMuted success error warning muted dim text thinkingText ' +
  'selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel ' +
  'toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode ' +
  'mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved ' +
  'toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber ' +
  'syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium ' +
  'thinkingHigh thinkingXhigh bashMode'
).split(' ');

async function buildFixture(temp, label, packageRequire) {
  const output = join(temp, `${label}.mjs`);
  await build({
    stdin: { contents: [
      `import ${JSON.stringify(join(upstream, 'worker/worker-deploy-runtime.ts'))};`,
      `export { createAllToolDefinitions } from ${JSON.stringify(join(upstream, 'agents/sessions/tools/index.ts'))};`,
      `export { loadThemeFromPath, getLanguageFromPath } from ${JSON.stringify(join(upstream, 'agents/modes/interactive/theme/theme.ts'))};`,
      `export { getTextOutput, replaceTabs, normalizeDisplayText, shortenPath, str } from ${JSON.stringify(join(upstream, 'agents/sessions/tools/render-utils.ts'))};`,
      `export { keyText, keyHint } from ${JSON.stringify(join(upstream, 'agents/modes/interactive/components/keybinding-hints.ts'))};`,
      `export { truncateToVisualLines } from ${JSON.stringify(join(upstream, 'agents/modes/interactive/components/visual-truncate.ts'))};`,
      // This fixture accesses the real dependency only when asked; it must share
      // constructor identity and mutable state with the production renderers.
      'export function terminal() { return require("@earendil-works/pi-tui"); }',
    ].join('\n'), resolveDir: core, loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    minify: process.env.CORE_MINIFY === '1', keepNames: process.env.CORE_MINIFY === '1',
    nodePaths: [join(core, 'node_modules'), ...packageRequire.resolve.paths('dependency')],
    loader: { '.sql': 'text' },
    define: { WORKER_DEPLOY_BUILD: 'true', WORKER_DEPLOY_VERSION: '"2026.8.1"' },
    banner: { js: `import {createRequire as __terminalCreateRequire} from 'node:module'; const require=__terminalCreateRequire(${JSON.stringify(join(core, 'package.json'))});` },
    plugins: [{ name: 'terminal-demand-and-baseline', setup(builder) {
      builder.onLoad({ filter: /[\\/]pi-tui[\\/]dist[\\/](?:index|utils)\.js$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')) + `\nglobalThis.__terminalRenderingDemand[${JSON.stringify(label)}][${JSON.stringify(path.endsWith('/index.js') ? 'index' : 'utils')}]++;`,
        loader: 'js',
      }));
      if (label === 'baseline') builder.onLoad({ filter: /[\\/]upstream[\\/]src[\\/].*\.ts$/ }, ({ path }) => {
        if (!originalOwners.has(relative(upstream, path))) return;
        return { contents: execFileSync('git', ['show', `${baselineCommit}:${relative(repo, path)}`], { cwd: repo, encoding: 'utf8' }), loader: 'ts' };
      });
    } }],
  });
  return import(pathToFileURL(output));
}

function renderContext(cwd, args, overrides = {}) {
  return { args, toolCallId: 'render-proof', cwd, invalidate() {}, state: {},
    lastComponent: undefined, executionStarted: false, argsComplete: false,
    isPartial: false, expanded: false, showImages: false, isError: false, ...overrides };
}

async function exerciseRenderers(m, definitions, temp, theme) {
  const observations = {};
  const lines = Array.from({ length: 35 }, (_, i) => `line ${i}: \t日本語 👩🏽‍💻 e\u0301 \x1b[31mred\x1b[39m`).join('\n');
  const args = {
    read: { path: 'example.txt', offset: 2, limit: 40 },
    write: { path: 'example.ts', content: 'const first = 1;\n' },
    edit: { path: 'example.txt', edits: [{ oldText: 'before', newText: 'after' }] },
    bash: { command: 'printf hello', timeout: 3 },
    grep: { pattern: 'hello', path: '.', glob: '*.txt', limit: 4 },
    find: { pattern: '*.txt', path: '.', limit: 4 },
    ls: { path: '.', limit: 4 },
  };
  for (const [name, tool] of Object.entries(definitions)) {
    const state = name === 'bash' ? { startedAt: 1000, endedAt: 2000, interval: undefined } : {};
    const context = renderContext(temp, args[name], { state });
    const call = tool.renderCall(args[name], theme, context);
    assert.equal(typeof call.render, 'function', `${name} returns a synchronous component`);
    const reused = tool.renderCall(args[name], theme, { ...context, lastComponent: call });
    assert.equal(reused, call, `${name} call reuses the previous component`);
    const result = { content: [{ type: 'text', text: lines }], details: { changed: false } };
    const resultContext = { ...context, lastComponent: undefined };
    const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, resultContext);
    assert.equal(typeof component.render, 'function', `${name} result is synchronous`);
    assert.equal(tool.renderResult(result, { expanded: false, isPartial: false }, theme,
      { ...resultContext, lastComponent: component }), component, `${name} result reuses the previous component`);
    observations[name] = { call: [call.render(80), call.render(18)], result: [component.render(80), component.render(18)] };
    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme,
      { ...resultContext, expanded: true, lastComponent: component });
    observations[name].expanded = expanded.render(80);
    const error = tool.renderResult({ content: [{ type: 'text', text: 'permission denied' }] },
      { expanded: false, isPartial: false }, theme, { ...resultContext, isError: true });
    observations[name].error = error.render(40);
  }

  const terminal = m.terminal();
  const bindings = new terminal.KeybindingsManager({ 'app.tools.expand': { defaultKeys: 'ctrl+o' } });
  terminal.setKeybindings(bindings);
  assert.equal(m.keyText('app.tools.expand'), 'ctrl+o');
  bindings.setUserBindings({ 'app.tools.expand': 'ctrl+e' });
  assert.equal(m.keyText('app.tools.expand'), 'ctrl+e');
  assert.match(m.keyHint('app.tools.expand', 'to expand'), /ctrl\+e/);
  terminal.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const image = { content: [{ type: 'text', text: 'ok\r\n' }, { type: 'image', mimeType: 'image/png' }] };
  assert.match(m.getTextOutput(image, true), /image\/png/);
  terminal.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
  assert.equal(m.getTextOutput(image, true), 'ok\n');
  assert.match(m.getTextOutput(image, false), /image\/png/);
  observations.imageFallback = m.getTextOutput(image, false);
  observations.visual = m.truncateToVisualLines(lines, 3, 18);
  assert.equal(observations.visual.visualLines.length, 3);
  assert.ok(observations.visual.skippedCount > 0);

  const readContext = renderContext(temp, args.read);
  assert.ok(definitions.read.renderCall(args.read, theme, readContext) instanceof terminal.Text);
  assert.ok(definitions.edit.renderCall(undefined, theme, renderContext(temp, undefined)) instanceof terminal.Box);
  const skillArgs = { path: 'skills/example/SKILL.md' };
  const skillContext = renderContext(temp, skillArgs);
  const skillCall = definitions.read.renderCall(skillArgs, theme, skillContext);
  observations.compactSkill = skillCall.render(80);
  assert.match(observations.compactSkill.join('\n'), /\[skill\]/);
  const skillOutput = { content: [{ type: 'text', text: 'skill body' }] };
  assert.deepEqual(definitions.read.renderResult(skillOutput, { expanded: false, isPartial: false }, theme, skillContext).render(80), []);
  observations.expandedSkill = definitions.read.renderResult(skillOutput,
    { expanded: true, isPartial: false }, theme, { ...skillContext, expanded: true }).render(80);
  assert.match(observations.expandedSkill.join('\n'), /skill body/);

  await writeFile(join(temp, 'example.txt'), 'before\n');
  const settled = Promise.withResolvers();
  const editContext = renderContext(temp, args.edit, { argsComplete: true, invalidate: settled.resolve });
  const editCall = definitions.edit.renderCall(args.edit, theme, editContext);
  assert.equal(editCall.previewPending, true);
  const settlementTimeout = setTimeout(() => settled.reject(new Error('edit preview did not settle')), 5000);
  try { await settled.promise; } finally { clearTimeout(settlementTimeout); }
  assert.equal(editCall.previewPending, false);
  assert.ok(editCall.preview && !('error' in editCall.preview));
  assert.match(editCall.preview.diff, /after/);
  assert.equal(definitions.edit.renderCall(args.edit, theme, { ...editContext, lastComponent: editCall }), editCall);
  observations.editPreview = editCall.render(80);
  definitions.edit.renderResult({ content: [{ type: 'text', text: 'edited' }], details: {
    changed: true, diff: editCall.preview.diff, firstChangedLine: 1,
  } }, { expanded: false, isPartial: false }, theme, editContext);
  observations.settledEdit = editCall.render(80);

  const writeContext = renderContext(temp, args.write, { isPartial: true });
  const write = definitions.write.renderCall(args.write, theme, writeContext);
  const previousCache = write.cache;
  const nextWriteArgs = { ...args.write, content: args.write.content + 'const second = 2;\n' };
  assert.equal(definitions.write.renderCall(nextWriteArgs, theme, { ...writeContext, args: nextWriteArgs, lastComponent: write }), write);
  assert.equal(write.cache, previousCache, 'streaming write retains its incremental highlight cache');
  assert.equal(write.cache.rawContent, nextWriteArgs.content);
  observations.streamingWrite = write.render(80);

  const bashState = { startedAt: 1000, endedAt: 2000, interval: undefined };
  const bashContext = renderContext(temp, args.bash, { state: bashState });
  try {
    const partial = definitions.bash.renderResult({ content: [{ type: 'text', text: lines }] },
      { expanded: false, isPartial: true }, theme, { ...bashContext, isPartial: true });
    assert.ok(bashState.interval, 'partial bash render schedules elapsed-time invalidation');
    assert.ok(partial instanceof terminal.Container);
    const state = partial.state;
    partial.render(18);
    assert.equal(state.cachedWidth, 18);
    const final = definitions.bash.renderResult({ content: [{ type: 'text', text: 'finished' }] },
      { expanded: false, isPartial: false }, theme, { ...bashContext, lastComponent: partial });
    assert.equal(final, partial);
    assert.equal(final.state, state);
    assert.equal(bashState.interval, undefined, 'final bash render clears elapsed-time timer');
    observations.finalBash = final.render(40);
  } finally {
    if (bashState.interval) clearInterval(bashState.interval);
  }
  return observations;
}

test('session tools defer terminal initialization and preserve real synchronous rendering', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'source-terminal-rendering-'));
  const themeKey = Symbol.for('openclaw:agent-theme');
  const previousTheme = globalThis[themeKey];
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = join(temp, 'state');
  globalThis.__terminalRenderingDemand = { baseline: { index: 0, utils: 0 }, candidate: { index: 0, utils: 0 } };
  try {
    const packageRequire = createRequire(await realpath(join(repo, 'node_modules/openclaw/package.json')));
    const baseline = await buildFixture(temp, 'baseline', packageRequire);
    const candidate = await buildFixture(temp, 'candidate', packageRequire);
    assert.deepEqual(globalThis.__terminalRenderingDemand.baseline, { index: 1, utils: 1 });
    assert.deepEqual(globalThis.__terminalRenderingDemand.candidate, { index: 0, utils: 0 }, 'headless module import must leave real terminal initializers cold');
    const definitions = candidate.createAllToolDefinitions(temp);
    assert.equal(candidate.getLanguageFromPath('example.ts'), 'typescript');
    assert.equal(candidate.replaceTabs('a\tb'), 'a   b');
    assert.equal(candidate.normalizeDisplayText('a\r\nb'), 'a\nb');
    assert.equal(candidate.str(null), '');
    assert.deepEqual(globalThis.__terminalRenderingDemand.candidate, { index: 0, utils: 0 }, 'tool discovery and pure helpers must stay cold');
    const themePath = join(temp, 'theme.json');
    await writeFile(themePath, JSON.stringify({ name: 'renderer-test', colors: Object.fromEntries(colorTokens.map(token => [token, '#123456'])) }));
    const observations = [];
    for (const [m, tools] of [[baseline, baseline.createAllToolDefinitions(temp)], [candidate, definitions]]) {
      const theme = m.loadThemeFromPath(themePath, 'truecolor');
      globalThis[themeKey] = theme;
      observations.push(await exerciseRenderers(m, tools, temp, theme));
      const terminal = m.terminal();
      terminal.setCapabilities({ images: null, trueColor: false, hyperlinks: false });
      assert.match(m.loadThemeFromPath(themePath).fg('accent', 'x'), /^\x1b\[38;5;/);
      terminal.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
      assert.match(m.loadThemeFromPath(themePath).fg('accent', 'x'), /^\x1b\[38;2;/);
    }
    assert.deepEqual(observations[1], observations[0], 'all seven real renderers retain baseline ANSI output and wrapping');
    assert.deepEqual(globalThis.__terminalRenderingDemand.candidate, { index: 1, utils: 1 }, 'all renderers share one terminal initialization');
  } finally {
    if (previousTheme === undefined) delete globalThis[themeKey];
    else globalThis[themeKey] = previousTheme;
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    delete globalThis.__terminalRenderingDemand;
    await rm(temp, { recursive: true, force: true });
  }
});
