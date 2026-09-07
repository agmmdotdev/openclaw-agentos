import { SourceMap } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/diagnostics/map-source-profile.mjs PROFILE_DIRECTORY');
const profile = JSON.parse(gunzipSync(readFileSync(join(directory, 'source-minified.cpuprofile.gz'))));
const map = new SourceMap(JSON.parse(readFileSync('packages/openclaw-core/dist/minified-index.mjs.map', 'utf8')));
const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
const totals = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const frame = nodes.get(profile.samples[i]);
  if (!frame.url.endsWith('/minified-index.mjs')) continue;
  const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
  const key = JSON.stringify({ source: entry.originalSource, line: (entry.originalLine ?? -1) + 1, function: frame.functionName || '(anonymous)' });
  totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[i] / 1000);
}
const rows = [...totals].sort((a, b) => b[1] - a[1]).map(([key, sampledMs]) => ({ ...JSON.parse(key), sampledMs }));
writeFileSync(join(directory, 'mapped-source-samples.json'), JSON.stringify({ note: 'Single core-only diagnostic profile. Generated frame starts mapped to source; unmapped wrappers remain explicit. Not per-line attribution or causal proof.', rows }, null, 2) + '\n');
