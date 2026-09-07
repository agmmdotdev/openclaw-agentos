#!/usr/bin/env python3
"""Check matched, uninstrumented PR #16 versus allocation-pass trials."""
import argparse, gzip, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, required=True)
args = parser.parse_args()
if len(args.trials) != 12 or len(set(args.trials)) != 12:
    parser.error('Expected 12 distinct trials: three per mode/initialization')
root = Path(__file__).resolve().parents[2]
reports = []
for trial in args.trials:
    paths = list((root / 'artifacts/results').glob(f'lifecycle-sdk-*-{trial}.json*'))
    paths = [p for p in paths if p.suffix != '.gz' or not p.with_suffix('').exists()]
    if len(paths) != 1: raise RuntimeError(f'Expected one report for {trial}')
    r = json.loads(gzip.decompress(paths[0].read_bytes()) if paths[0].suffix == '.gz' else paths[0].read_bytes())
    if not r['valid'] or r['turns'] != 7 or r['backend'] != 'sdk' or 'startupDiagnostics' in r:
        raise RuntimeError(f'Invalid comparison trial {trial}')
    if r['environment']['profile'] != 'request' or r['environment']['requestLauncher'] != 'single':
        raise RuntimeError('Expected single-start request profile')
    if r['benchmarkManifest']['nativeLayout']['mode'] != 'bundled':
        raise RuntimeError('Expected bundled layout')
    reports.append(r)
for key in ['benchmarkManifest', 'harnessSha256', 'samplerSha256', 'requestLauncherSha256', 'singleStartupLauncher', 'sampleIntervalMs']:
    if len({json.dumps(r[key], sort_keys=True) for r in reports}) != 1:
        raise RuntimeError(f'Comparison inputs changed: {key}')
if len({json.dumps({k: v for k, v in r['environment'].items() if k != 'initialization'}, sort_keys=True) for r in reports}) != 1:
    raise RuntimeError('Comparison environment changed')
groups = []
for mode in ['request-cache', 'resident']:
    for initialization in ['before-allocations', 'current']:
        selected = [r for r in reports if r['mode'] == mode and r['environment']['initialization'] == initialization]
        if len(selected) != 3: raise RuntimeError('Expected three trials per group')
        prefix = 'before-allocations-' if initialization == 'before-allocations' else ''
        entry = f'artifacts/core/{prefix}native-sdk-core-benchmark.mjs'
        if any(r['entrySha256'] != r['benchmarkManifest']['hashes'][entry] for r in selected):
            raise RuntimeError('Entry differs from comparison manifest')
        metrics = {}
        for key in selected[0]['summary']:
            values = [r['summary'][key] for r in selected]
            metrics[key] = None if any(v is None for v in values) else {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
        groups.append({'mode': mode, 'initialization': initialization,
                       'trials': [r['trial'] for r in selected], 'entrySha256': selected[0]['entrySha256'], 'metrics': metrics})
result = {'method': 'Three serial alternating trials per group; seven turns/35 real tools each; same bundled layout and single-start request profile; empty compilation cache per cached trial; 420 ms scripted inference per turn; external sampler excluded.',
          'benchmarkManifest': reports[0]['benchmarkManifest'], 'groups': groups}
path = root / 'artifacts/results/native-allocation-pass-summary.json'
with path.open('w') as f:
    json.dump(result, f, indent=2)
    f.write('\n')
for group in groups:
    print(json.dumps({**group, 'metrics': {k: v for k, v in group['metrics'].items() if k in ['totalCpuSeconds', 'subsequentProcessMedianMs', 'peakPssMiB', 'idleCorePssMiB']}}))
