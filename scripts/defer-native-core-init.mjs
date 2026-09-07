import ts from 'typescript';
import { createHash } from 'node:crypto';

// Reviewed against the hash-pinned, sliced OpenClaw 2026.8.1 worker. Native
// artifact only: retain the exact libraries, schema definitions and validators.
export function deferNativeCoreInitialization(source) {
  const ast = ts.createSourceFile('native-core.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = new Map();
  function visit(node) {
    if (ts.isIdentifier(node)) references.set(node.text, (references.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const [name, expected] of Object.entries({
    import_lib$12: 2, es_default: 2, worker_deploy_highlight_runtime_default: 2,
    require_lib$9: 2, OpenClawSchema: 3, init_zod_schema: 2, installZodDefaultLocale: 2,
  })) {
    if (references.get(name) !== expected) throw new Error(`Lazy initialization reference boundary changed: ${name}`);
  }
  const patches = [];
  function replace(before, after, boundary) {
    if (source.split(before).length !== 2) throw new Error(`Lazy initialization text boundary changed: ${boundary}`);
    source = source.replace(before, after);
    patches.push({ boundary, beforeSha256: hash(before), afterSha256: hash(after) });
  }
  // The registration stores a private loader sentinel. The single runtime
  // getter resolves it to the original object, once. Runtime replacements still
  // use the original setter, including an explicitly undefined replacement.
  replace('var import_lib$12=__toESM(require_lib$9());\nvar es_default=import_lib$12.default;\nvar worker_deploy_highlight_runtime_default=es_default;',
    'var worker_deploy_highlight_runtime_default=()=>__toESM(require_lib$9()).default;', 'highlight registration');
  replace('function getWorkerDeployHighlightJs(){return runtime$2.highlightJs}',
    'function getWorkerDeployHighlightJs(){let value=runtime$2.highlightJs;if(value===worker_deploy_highlight_runtime_default)runtime$2.highlightJs=value=value();return value}', 'highlight access');
  // Locale registration is a global side effect and must remain eager. Move it
  // out of schema construction so lazy validation cannot reset a later locale.
  replace('init_zod_schema_core(),init_zod_schema(),init_zod_schema_root_support()',
    'init_zod_schema_core(),installZodDefaultLocale(),init_zod_schema_root_support()', 'validation initializer');
  replace('init_zod_schema_root_shape(),installZodDefaultLocale(),OpenClawSchema=',
    'init_zod_schema_root_shape(),OpenClawSchema=', 'schema locale');
  replace('function validateConfigObjectRaw(Ot,Zt){',
    'function validateConfigObjectRaw(Ot,Zt){init_zod_schema();', 'validation entry');
  return { source, report: { mode: 'lazy', patches, preservesEagerLocale: true } };
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
