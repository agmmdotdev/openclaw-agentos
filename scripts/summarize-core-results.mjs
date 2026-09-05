import { readFile, writeFile, copyFile } from 'node:fs/promises';
const core = JSON.parse(await readFile('artifacts/results/core-probe.json', 'utf8'));
const asyncContext = JSON.parse(await readFile('artifacts/results/async-context.json', 'utf8'));
const scenarios = core.reports.map(report => ({
  generation: report.generation,
  processOutcome: report.result.outcome,
  exitCode: report.result.exitCode,
  durationMs: report.durationMs,
  sqliteCalls: report.sqliteCalls,
  checks: report.result.stdout.split('\n').flatMap(line => {
    const match = /^(CAPABILITIES_RESULT|CORE_RESULT|CORE_PROFILE_RESULT|SCHEMA_BATCH_RESULT|CANONICAL_BATCH_RESULT|FAILURE_CASES_RESULT)=(.*)$/.exec(line);
    return match ? [{ kind: match[1], ...JSON.parse(match[2]) }] : [];
  }),
}));
const passing = core.validationPassed !== false && scenarios.length === 3 && scenarios.every(s => s.exitCode === 0 && s.processOutcome === 'succeeded' && s.checks.length > 0)
  && core.reports.every(report => !/failed to asynchronously prepare wasm|Aborted\(Error:.*\/core\//.test(report.result.stderr ?? ''))
  && asyncContext.adaptedMatchesNode && asyncContext.compiledNodeMatchesNative;
await copyFile('artifacts/core/manifest.json', 'artifacts/results/core-build.json');
await writeFile('artifacts/results/summary.json', JSON.stringify({
  recordedAt: core.recordedAt,
  versions: { node: core.node, openclaw: core.openclaw, agentos: core.agentos, sqlite: core.sqlite.version },
  runtimeEnvironment: core.runtimeEnvironment,
  artifactMode: core.artifactMode ?? 'upload',
  compatibilityGate: passing ? 'passed' : 'failed',
  asyncContext: { adaptedMatchesNode: asyncContext.adaptedMatchesNode, compiledNodeMatchesNative: asyncContext.compiledNodeMatchesNative, rawRuntimeStillUnsupported: true },
  scenarios,
}, null, 2) + '\n');
console.log(`Compatibility gate: ${passing ? 'passed' : 'failed'}`);
if (!passing) process.exitCode = 1;
