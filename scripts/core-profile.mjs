import ts from 'typescript';
import { sliceCoreArtifact } from './slice-core-artifact.mjs';

export function prepareCoreProfile(source) {
  // These paths are disabled by the existing embedded worker: its in-memory
  // settings disable compaction and its resource loader sets noExtensions.
  // Keep explicit failures if a future caller reaches either omitted boundary.
  const lazyCompact = '()=>Promise.resolve().then(()=>(init_compact_runtime(),compact_runtime_exports))';
  if (source.split(lazyCompact).length !== 2) throw new Error('Lazy compaction boundary changed');
  source = source.replace(lazyCompact, '()=>{throw new Error("Unsupported core profile: gateway compaction runtime")}');
  const ast = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const loaders = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadExtensionSourceTransformModule');
  if (loaders.length !== 1 || !loaders[0].body) throw new Error('Extension loader boundary changed');
  const body = loaders[0].body;
  source = source.slice(0, body.getStart(ast)) + '{throw new Error("Unsupported core profile: source extension loader")}' + source.slice(body.end);
  const result = sliceCoreArtifact(source);
  result.report.excludedBoundaries = ['gateway compaction runtime', 'source extension loader'];
  return result;
}
