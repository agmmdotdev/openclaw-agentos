#!/usr/bin/env python3
import argparse, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, required=True)
args = parser.parse_args()
if len(args.trials) != 6 or len(set(args.trials)) != 6: parser.error('Six distinct matched trials required')
root = Path(__file__).resolve().parents[2]
reports = [json.loads((root / f'artifacts/results/lifecycle-sdk-request-cache-{trial}.json').read_text()) for trial in args.trials]
for r in reports:
    if not r['valid'] or r['turns'] != 7 or r.get('startupDiagnostics') or r['environment']['profile'] != 'request' or r['environment']['initialization'] != 'bundled':
        raise RuntimeError('Expected valid uninstrumented bundled-lazy request comparison')
for key in ['benchmarkManifest', 'entrySha256', 'harnessSha256', 'samplerSha256', 'sampleIntervalMs']:
    if len({json.dumps(r[key], sort_keys=True) for r in reports}) != 1: raise RuntimeError('Inputs changed: ' + key)
if len({json.dumps({k: v for k, v in r['environment'].items() if k != 'requestLauncher'}, sort_keys=True) for r in reports}) != 1:
    raise RuntimeError('Comparison environment changed')
groups = []
for launcher in ['execve', 'single']:
    selected = [r for r in reports if r['environment']['requestLauncher'] == launcher]
    if len(selected) != 3: raise RuntimeError('Expected three trials per launcher')
    if len({r['requestLauncherSha256'] for r in selected}) != 1 or len({json.dumps(r['singleStartupLauncher'], sort_keys=True) for r in selected}) != 1:
        raise RuntimeError('Launcher changed within group')
    metrics = {}
    for key in selected[0]['summary']:
        values = [r['summary'][key] for r in selected]
        metrics[key] = None if any(v is None for v in values) else {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
    groups.append({'launcher': launcher, 'trials': [r['trial'] for r in selected], 'metrics': metrics,
        'launcherSha256': selected[0]['requestLauncherSha256'], 'singleStartupLauncher': selected[0]['singleStartupLauncher']})
result = {'method': 'Three serial alternating uninstrumented trials per launcher in the same session. Seven turns/35 real tools, initially empty JS compile cache, same bundled lazy core, two CPUs, allocator and Wasm profile. Inference scripted at 420ms per turn; sampler excluded.',
    'benchmarkManifest': reports[0]['benchmarkManifest'], 'entrySha256': reports[0]['entrySha256'], 'groups': groups}
path = root / 'artifacts/results/request-launcher-summary.json'
path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(groups))
