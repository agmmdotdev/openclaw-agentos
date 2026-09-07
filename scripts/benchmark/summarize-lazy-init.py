#!/usr/bin/env python3
import argparse, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
reports = []
for trial in args.trials:
    matches = list((root / 'artifacts/results').glob(f'lifecycle-sdk-*-{trial}.json'))
    if len(matches) != 1: raise RuntimeError(f'Expected one report for {trial}')
    r = json.loads(matches[0].read_text())
    if not r['valid'] or r['turns'] != 7 or r['environment']['profile'] != 'request' or r['benchmarkManifest']['nativeInitialization']['mode'] != 'lazy':
        raise RuntimeError(f'Invalid comparison trial {trial}')
    reports.append(r)
if len({json.dumps(r['benchmarkManifest'], sort_keys=True) for r in reports}) != 1:
    raise RuntimeError('Build inputs changed during comparison')
groups = []
for mode in ['request-cache', 'resident']:
    for initialization in ['eager', 'current']:
        selected = [r for r in reports if r['mode'] == mode and r['environment']['initialization'] == initialization]
        if len(selected) != 3: raise RuntimeError('Expected three trials per group')
        if len({r['entrySha256'] for r in selected}) != 1: raise RuntimeError('Entry changed within group')
        metrics = {}
        for key in selected[0]['summary']:
            values = [r['summary'][key] for r in selected]
            metrics[key] = None if any(v is None for v in values) else {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
        groups.append({'mode': mode, 'initialization': initialization, 'trials': [r['trial'] for r in selected], 'entrySha256': selected[0]['entrySha256'], 'metrics': metrics})
result = {'method': 'Three serial alternating trials per group; seven turns/35 real tools each. Both variants use the request Wasm profile, two allowed CPUs, identical SDK/fixtures and a fresh compilation cache per trial. 420 ms scripted inference per turn. External sampler excluded.', 'benchmarkManifest': reports[0]['benchmarkManifest'], 'groups': groups}
path = root / 'artifacts/results/native-lazy-init-summary.json'
path.write_text(json.dumps(result, indent=2) + '\n')
print(path)
