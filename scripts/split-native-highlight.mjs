import ts from 'typescript';
import { createHash } from 'node:crypto';

// A checked dependency boundary for the pinned, lazy native artifact only.
// Keep declaration text intact; copy only the stateless CJS wrapper helper.
export function splitNativeHighlight(source) {
  const file = '/native-core.mjs';
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost({});
  host.getSourceFile = name => name === file ? ast : undefined;
  const checker = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true }, host).getTypeChecker();
  const units = [], owners = new Map();
  for (const statement of ast.statements) {
    const names = ts.isVariableStatement(statement) ? [...statement.declarationList.declarations].map(d => d.name)
      : statement.name ? [statement.name] : [];
    const unit = { statement, names };
    units.push(unit);
    for (const name of names) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) owners.set(symbol, unit);
    }
  }
  const symbolAt = node => ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
  const root = units.find(u => u.names.some(n => n.text === 'require_lib$9'));
  if (!root) throw new Error('Missing highlighter root');
  const selected = new Set();
  function retain(unit) {
    if (selected.has(unit)) return;
    selected.add(unit);
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const dependency = owners.get(symbolAt(node));
        if (dependency && dependency !== unit) retain(dependency);
      }
      ts.forEachChild(node, visit);
    }
    visit(unit.statement);
  }
  retain(root);
  const helper = units.find(u => u.names.some(n => n.text === '__commonJSMin'));
  if (selected.size !== 196 || !selected.has(helper)
    || helper.statement.getText(ast) !== 'var __commonJSMin=(Ot,Zt)=>()=>(Zt||(Ot((Zt={exports:{}}).exports,Zt),Ot=null),Zt.exports);') {
    throw new Error('Highlighter dependency boundary changed');
  }
  const removed = new Set([...selected].filter(u => u !== helper));
  for (const unit of removed) {
    const statement = unit.statement;
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1
      || !ts.isIdentifier(unit.names[0]) || !unit.names[0].text.startsWith('require_')) throw new Error('Highlighter declaration boundary changed');
    const init = statement.declarationList.declarations[0].initializer;
    if (!init || !ts.isCallExpression(init) || init.expression.getText(ast) !== '__commonJSMin') throw new Error('Highlighter eager side effect boundary changed');
  }
  const movedNames = new Set([...removed].flatMap(u => u.names.map(n => n.text)));
  let externalRootReferences = 0;
  for (const unit of units) {
    if (removed.has(unit)) continue;
    function visit(node) {
      if (ts.isIdentifier(node) && movedNames.has(node.text)) {
        const owner = owners.get(symbolAt(node));
        if (removed.has(owner)) {
          if (owner !== root) throw new Error(`External highlighter dependency: ${node.text}`);
          externalRootReferences++;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(unit.statement);
  }
  if (externalRootReferences !== 1) throw new Error('Highlighter loader consumer boundary changed');
  const loader = 'var worker_deploy_highlight_runtime_default=()=>__toESM(require_lib$9()).default;';
  if (source.split(loader).length !== 2 || source.includes('__nativeHighlight')) throw new Error('Highlighter loader text boundary changed');
  const notices = [...new Set(source.match(/\/\*![\s\S]*?\*\//g) ?? [])].join('\n');
  // A factory preserves per-core library identity even if several core modules
  // share this file in Node's require cache. No mutable library singleton leaks.
  const moduleSource = '"use strict";\n' + notices + '\nmodule.exports=()=>{\n'
    + units.filter(u => selected.has(u)).map(u => u.statement.getText(ast)).join('\n')
    + '\nreturn require_lib$9();\n};\n';
  let entry = source;
  for (const unit of [...removed].sort((a, b) => b.statement.pos - a.statement.pos)) {
    entry = entry.slice(0, unit.statement.getStart(ast)) + entry.slice(unit.statement.end);
  }
  entry = 'import { createRequire as __nativeHighlightCreateRequire } from "node:module";\n'
    + 'const __nativeHighlightRequire=__nativeHighlightCreateRequire(import.meta.url);\n'
    + entry.replace(loader, 'var worker_deploy_highlight_runtime_default=()=>__toESM(__nativeHighlightRequire("./native-highlight.cjs")()).default;');
  return { source: entry, moduleSource, report: { mode: 'split', removedDeclarations: removed.size,
    inputBytes: Buffer.byteLength(source), entryBytes: Buffer.byteLength(entry), moduleBytes: Buffer.byteLength(moduleSource),
    inputSha256: hash(source), entrySha256: hash(entry), moduleSha256: hash(moduleSource),
    factoryPerCore: true, retainedLegalNotices: true } };
}
const hash = value => createHash('sha256').update(value).digest('hex');
