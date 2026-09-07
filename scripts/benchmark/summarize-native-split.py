#!/usr/bin/env python3
"""Matched lazy-bundled versus lazy-split native core trials."""
import argparse, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, required=True)
args = parser.parse_args()
if len(args.trials) != 18 or len(set(args.trials)) != 18:
    parser.error('Supply 18 distinct trials: three per mode/layout')
root = Path(__file__).resolve().parents[2]
reports = []
for trial in args.trials:
    paths = list((root / 'artifacts/results').glob(f'lifecycle-sdk-*-{trial}.json'))
    if len(paths) != 1: raise RuntimeError(f'Expected one report for {trial}')
    r = json.loads(paths[0].read_text())
    if not r['valid'] or r['turns'] != 7 or r['backend'] != 'sdk' or r['environment']['profile'] != 'request':
        raise RuntimeError(f'Invalid comparison trial {trial}')
    if r['benchmarkManifest']['nativeInitialization']['mode'] != 'lazy' or r['benchmarkManifest']['nativeLayout']['mode'] != 'split':
        raise RuntimeError('Expected lazy split build and lazy bundled control')
    reports.append(r)
for key in ['benchmarkManifest', 'harnessSha256', 'samplerSha256', 'requestLauncherSha256', 'sampleIntervalMs']:
    if len({json.dumps(r[key], sort_keys=True) for r in reports}) != 1:
        raise RuntimeError(f'Comparison inputs changed: {key}')
if len({json.dumps({k: v for k, v in r['environment'].items() if k != 'initialization'}, sort_keys=True) for r in reports}) != 1:
    raise RuntimeError('Comparison environment changed')
groups = []
for mode in ['request-cache', 'resident', 'request']:
    for initialization in ['bundled', 'current']:
        selected = [r for r in reports if r['mode'] == mode and r['environment']['initialization'] == initialization]
        if len(selected) != 3: raise RuntimeError('Expected three trials per group')
        expected_entry = f'artifacts/core/{"bundled-native" if initialization == "bundled" else "native"}-sdk-core-benchmark.mjs'
        if any(r['entrySha256'] != r['benchmarkManifest']['hashes'][expected_entry] for r in selected):
            raise RuntimeError('Entry differs from comparison manifest')
        metrics = {}
        for key in selected[0]['summary']:
            values = [r['summary'][key] for r in selected]
            metrics[key] = None if any(v is None for v in values) else {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
        groups.append({'mode': mode, 'layout': 'bundled' if initialization == 'bundled' else 'split',
                       'trials': [r['trial'] for r in selected], 'entrySha256': selected[0]['entrySha256'], 'metrics': metrics})
result = {'method': 'Three serial rotated trials per group; seven turns/35 real tools each. Both variants retain lazy initialization and use the opt-in request Wasm profile, two CPUs, identical SDK/fixtures and an empty compilation cache per cached trial. 420 ms scripted inference per turn. External sampler excluded.',
          'benchmarkManifest': reports[0]['benchmarkManifest'], 'groups': groups}
path = root / 'artifacts/results/native-split-summary.json'
path.write_text(json.dumps(result, indent=2) + '\n')
print(path)
