// Appended inside each real core's module scope, in independent processes.
function __initCheck(value, message) { if (!value) throw new Error(message); }
__initCheck(__testHighlightLoads === (__testMode === 'lazy' ? 0 : 1), 'eager highlight loading changed');
init_embedded_agent_runtime();
__initCheck(__testSchemaLoads === (__testMode === 'lazy' ? 0 : 1), 'root schema initialized too early');
__initCheck(__testHighlightLoads === (__testMode === 'lazy' ? 0 : 1), 'embedded init loaded highlighting');
if (__testSplit) __initCheck(!__nativeHighlightRequire.cache[__nativeHighlightRequire.resolve('./native-highlight.cjs')], 'split module loaded before demand');

// A distinct schema's errors must have the same eager default locale, even
// before any root configuration validation. A later custom locale must survive.
const __initLocaleBefore = string$3().safeParse(42).error.issues;
config$1({ localeError: () => 'custom-locale-preserved' });
const __initConfigs = [
  {}, { unknownOption: true }, null, [], { gateway: { port: -1 } },
  { gateway: { port: 18789 } }, { agents: { defaults: { model: 'openai/gpt-4.1' } } },
  { agents: { defaults: { timeoutSeconds: -1 } } }, { tools: { exec: { security: 'invalid' } } },
  { tools: { exec: { security: 'full', ask: 'off' } } }, { session: { scope: 'invalid' } },
  { env: { vars: { CUSTOM_VALUE: 'value' } } }, { gateway: { port: 'bad' } },
  { models: { providers: { custom: { baseUrl: 'https://example.invalid', models: [] } } } },
  { agents: { entries: { main: { identity: { name: 'Test' } } } } },
  { tools: { exec: { timeoutSec: 'invalid' } } },
];
const __initValidationResults = __initConfigs.map(value => validateConfigObjectRaw(value));
__initCheck(__testSchemaLoads === 1, 'schema did not initialize exactly once');
__initCheck(string$3().safeParse(42).error.issues[0].message === 'custom-locale-preserved', 'lazy schema reset the locale');
init_embedded_agent_runtime();
__initCheck(__testSchemaLoads === 1, 'repeated init rebuilt schema');

// Runtime replacement must neither invoke the pending loader nor restore a
// runtime that the caller explicitly cleared. Keep the original registration.
const __initRegistered = runtime$2.highlightJs;
const __initReplacement = { customRuntime: true };
const __initOtherRuntime = { json5: getWorkerDeployJson5(), resolveSecureTempRoot: getWorkerDeploySecureTempRoot() };
setWorkerDeployRuntime({ ...__initOtherRuntime, highlightJs: __initReplacement });
__initCheck(getWorkerDeployHighlightJs() === __initReplacement, 'runtime replacement lost');
setWorkerDeployRuntime({ ...__initOtherRuntime, highlightJs: undefined });
__initCheck(getWorkerDeployHighlightJs() === undefined, 'explicitly cleared runtime loaded');
setWorkerDeployRuntime({ ...__initOtherRuntime, highlightJs: __initRegistered });
__initCheck(__testHighlightLoads === (__testMode === 'lazy' ? 0 : 1), 'replacement forced highlight load');
const __initHighlighter = getWorkerDeployHighlightJs();
__initCheck(getWorkerDeployHighlightJs() === __initHighlighter && __testHighlightLoads === 1, 'highlighter identity or cache changed');
if (__testSplit) __initCheck(!!__nativeHighlightRequire.cache[__nativeHighlightRequire.resolve('./native-highlight.cjs')], 'split module did not use the checked artifact');
const __initHighlightCases = [
  ['javascript', 'const value = 42; // hello'], ['typescript', 'interface User { name: string }'],
  ['python', 'def f(x):\n    return x + 1'], ['bash', 'echo "$(pwd)" | cat'],
  ['json', '{"name":"မြန်မာ 🐈","ok":true}'], ['yaml', 'name: test\nitems:\n  - one'],
  ['sql', 'SELECT * FROM users WHERE id = 1'], ['cpp', '#include <iostream>\nint main() { return 0; }'],
  ['rust', 'fn main() { println!("hello"); }'], ['go', 'package main\nfunc main() {}'],
  ['html', '<div class="test">hello</div>'], ['css', '.test { color: red; }'],
  ['markdown', '# Heading\n**bold**'], ['diff', '-old\n+new'], ['dockerfile', 'FROM node:24\nRUN npm ci'],
];
const __initLanguages = __initHighlighter.listLanguages();
const __initHighlights = __initHighlightCases.map(([language, code]) => {
  const result = __initHighlighter.highlight(code, { language, ignoreIllegals: true });
  return { language: result.language, value: result.value, illegal: result.illegal, relevance: result.relevance };
});
const __initAuto = __initHighlighter.highlightAuto('const value = 42;', ['javascript', 'python']);
__initHighlighter.registerLanguage('fixture', () => ({ keywords: 'custom', aliases: ['fixture-alias'] }));
const __initCustom = __initHighlighter.highlight('custom value', { language: 'fixture-alias' }).value;
__initHighlighter.unregisterLanguage('fixture');
__initCheck(!__initHighlighter.getLanguage('fixture'), 'custom language was not unregistered');
console.log(JSON.stringify({ localeBefore: __initLocaleBefore, configs: __initValidationResults,
  languages: __initLanguages, highlights: __initHighlights, auto: { value: __initAuto.value, language: __initAuto.language }, custom: __initCustom }));
