import { transform, version } from 'esbuild';
import ts from 'typescript';

export const asyncCompiler = {
  name: 'esbuild', version,
  supported: { 'async-await': false, 'async-generator': false, 'for-await': false },
};

export async function compileAsync(source) {
  const result = await transform(source, {
    loader: 'js', format: 'esm', target: 'esnext',
    supported: asyncCompiler.supported, keepNames: true, minifyWhitespace: true,
  });
  // The pinned upstream Babel payload contains a duplicate switch case.
  // Keep its behavior; reject any other newly exposed compiler diagnostic.
  const unexpected = result.warnings.filter(warning => warning.id !== 'duplicate-case');
  if (unexpected.length) throw new Error(JSON.stringify(unexpected.map(({ id, text }) => ({ id, text }))));
  return result.code;
}

// Fixtures have module imports and top-level awaits. Only the root scheduling
// await remains native; every callback and continuation under test is lowered.
export async function compileFixture(source) {
  const ast = ts.createSourceFile('fixture.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [], body = [];
  for (const statement of ast.statements) {
    (ts.isImportDeclaration(statement) ? imports : body).push(statement.getFullText(ast));
  }
  const compiled = await compileAsync('async function __coreFixtureMain() {\n' + body.join('\n') + '\n}\n');
  // Helpers such as __await must not collide with the upstream bundle when
  // the fixture is appended to its lexical scope for the streamed launch.
  return imports.join('\n') + '\nawait (function () {\n' + compiled + '\nreturn __coreFixtureMain();\n})();\n';
}
