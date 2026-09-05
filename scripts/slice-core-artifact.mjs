import ts from 'typescript';

// Generated-module reachability for this pinned standalone artifact. Original
// declaration text is retained, including lazy initializer bodies and order.
export function sliceCoreArtifact(source, options = {}) {
  const file = '/worker.mjs';
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost({});
  host.getSourceFile = name => name === file ? ast : undefined;
  host.fileExists = name => name === file;
  host.readFile = name => name === file ? source : undefined;
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, noLib: true }, host);
  const checker = program.getTypeChecker();
  const units = [], owners = new Map();
  function names(node) {
    if (ts.isIdentifier(node)) return [node];
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) return node.elements.flatMap(e => ts.isBindingElement(e) ? names(e.name) : []);
    return [];
  }
  function expressions(node) {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken
      ? [...expressions(node.left), ...expressions(node.right)] : [node];
  }
  const top = ast.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations].map(declaration => ({ node: declaration, prefix: statement.declarationList.flags & ts.NodeFlags.Const ? 'const ' : statement.declarationList.flags & ts.NodeFlags.Let ? 'let ' : 'var ' }))
    : ts.isExpressionStatement(statement) ? expressions(statement.expression).map(node => ({ node, prefix: '', eager: true }))
    : [{ node: statement, prefix: '' }]);
  for (const { node: statement, prefix, eager } of top) {
    if (ts.isExportDeclaration(statement)) continue;
    let declarations = [];
    if (ts.isVariableDeclaration(statement)) declarations = names(statement.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations = [statement.name];
    else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      declarations = [clause?.name, ...(clause?.namedBindings ? ts.isNamespaceImport(clause.namedBindings) ? [clause.namedBindings.name] : clause.namedBindings.elements.map(e => e.name) : [])].filter(Boolean);
    }
    const unit = { statement, prefix, eager, declarations, dependencies: new Set() };
    units.push(unit);
    for (const name of declarations) { const symbol = checker.getSymbolAtLocation(name); if (symbol) owners.set(symbol, unit); }
  }
  for (const unit of units) {
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if ((ts.isBindingElement(parent) && parent.propertyName === node) || (ts.isImportSpecifier(parent) && parent.propertyName === node) || (ts.isPropertyAccessExpression(parent) && parent.name === node) || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)) return;
        const symbol = checker.resolveName(node.text, node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false);
        const owner = owners.get(symbol);
        if (owner && owner !== unit) unit.dependencies.add(owner);
      }
      ts.forEachChild(node, visit);
    }
    visit(unit.statement);
  }
  const roots = options.roots ?? ['init_embedded_agent_runtime', 'runWorkerEmbeddedTurn'];
  const selected = new Set();
  function retain(unit) { if (!unit || selected.has(unit)) return; selected.add(unit); for (const dependency of unit.dependencies) retain(dependency); }
  for (const name of roots) {
    const unit = units.find(u => u.declarations.some(d => d.text === name));
    if (!unit) throw new Error(`Missing core root: ${name}`);
    retain(unit);
  }
  // Standalone runtime registration is intentionally eager in upstream.
  const registrations = options.registerRuntime === false ? [] : units.filter(u => u.eager && u.statement.getText(ast).startsWith('setWorkerDeployRuntime('));
  if (options.registerRuntime !== false && registrations.length !== 1) throw new Error('Core registration boundaries changed');
  registrations.forEach(retain);
  // Preserve eager upstream calls to every retained initializer in source order.
  // Some modules rely on these registrations instead of declaring their own init
  // dependency. Splitting comma expressions avoids pulling unrelated CLI modules.
  let changed;
  do {
    changed = false;
    for (const unit of units) {
      if (!unit.eager || selected.has(unit) || !ts.isCallExpression(unit.statement)) continue;
      const callee = unit.statement.expression;
      if (!ts.isIdentifier(callee) || !callee.text.startsWith('init_')) continue;
      if ([...unit.dependencies].some(dependency => selected.has(dependency))) {
        const size = selected.size; retain(unit); changed ||= selected.size !== size;
      }
    }
  } while (changed);
  const paths = {};
  const queue = [...units.filter(u => u.declarations.some(d => roots.includes(d.text))), ...registrations].map(u => [u, []]);
  const seen = new Set();
  for (let i=0; i<queue.length; i++) {
    const [unit, path] = queue[i]; if (seen.has(unit)) continue; seen.add(unit);
    const name = unit.declarations[0]?.text ?? '<registration>';
    const next = [...path, name];
    if (['require_typescript','require_babel','init_bundled_channel_config_metadata_generated'].includes(name)) paths[name] = next;
    for (const dependency of unit.dependencies) if (!seen.has(dependency)) queue.push([dependency,next]);
  }
  const largest = [...selected].sort((a,b)=>b.statement.getWidth(ast)-a.statement.getWidth(ast)).slice(0,12).map(u=>({names:u.declarations.map(x=>x.text).slice(0,6),bytes:Buffer.byteLength(u.statement.getText(ast))}));
  // Retain all upstream bang-style legal notices conservatively, including
  // notices preceding a split var declaration. Never discard licensing text
  // merely because the minifier attached it to a declaration we removed.
  const legalNotices = [...new Set(source.match(/\/\*![\s\S]*?\*\//g) ?? [])].join('\n');
  const output = legalNotices + '\n' + units.filter(u => selected.has(u)).map(u => u.prefix ? u.prefix + u.statement.getText(ast) + ';' : u.statement.getFullText(ast) + (u.eager ? ';' : '')).join('\n') + (options.wrapper ?? '\nexport async function runOpenClawCoreTurn(params) { init_embedded_agent_runtime(); return runWorkerEmbeddedTurn(params); }\n');
  return { source: output, report: { roots, paths, largest, inputStatements: units.length, retainedStatements: selected.size, removedBytes: Buffer.byteLength(source) - Buffer.byteLength(output), legalNoticeBytes: Buffer.byteLength(legalNotices), eagerInitializers: [...selected].filter(u => u.eager).length, retainedRegistrations: registrations.map(u => u.statement.getText(ast).slice(0,180)) } };
}
