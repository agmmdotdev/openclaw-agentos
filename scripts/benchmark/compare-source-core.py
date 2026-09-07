#!/usr/bin/env python3
"""Summarize source migration trials without mixing historical controls."""
import argparse, gzip, hashlib, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', type=int, nargs='+', required=True)
parser.add_argument('--source-layout', choices=['standard', 'minified'], default='standard')
parser.add_argument('--mode', choices=['request-cache', 'resident'], default='request-cache')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
source = 'sdk-source' + ('-minified' if args.source_layout == 'minified' else '')
reports = {backend: [] for backend in ['sdk', source]}
inputs = []
for trial in args.trials:
    pair = []
    for backend in reports:
        path = root / f'artifacts/results/lifecycle-{backend}-{args.mode}-{trial}.json'
        if not path.exists(): path = path.with_suffix('.json.gz')
        raw = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
        report = json.loads(raw)
        if not report['valid']: raise ValueError(f'Invalid trial: {path}')
        if any('failed to asynchronously prepare wasm' in line or line.startswith('Aborted(')
               for run in report['runs'] for line in run['logs']):
            raise ValueError(f'Parser fallback compromises comparison: {path}')
        reports[backend].append(report)
        pair.append(report)
        inputs.append({'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    for key in ['environment', 'turns', 'sampleIntervalMs', 'benchmarkManifest', 'requestLauncherSha256', 'samplerSha256']:
        if pair[0][key] != pair[1][key]: raise ValueError(f'Unmatched {key}: {trial}')

keys = ['totalCpuSeconds', 'subsequentProcessMedianMs', 'peakPssMiB', 'warmTurnMedianMs', 'idleCorePssMiB']
summary = {}
for backend, rows in reports.items():
    metrics = {}
    for key in keys:
        values = [r['summary'][key] for r in rows if r['summary'][key] is not None]
        if values: metrics[key] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    if args.mode == 'request-cache':
        values = [statistics.median(run['peakPssMiB'] for run in r['runs'][1:]) for r in rows]
        metrics['cachedProcessPeakPssMiB'] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    metrics['maxProcessWallMs'] = max(run['wallMs'] for r in rows for run in r['runs'])
    summary[backend] = metrics
changes = {key: (summary[source][key]['median'] / value['median'] - 1) * 100
           for key, value in summary['sdk'].items() if isinstance(value, dict) and value['median']}
print(json.dumps({'trials': args.trials, 'mode': args.mode, 'sourceLayout': args.source_layout,
                  'method': 'Median of per-trial statistics; fresh paired controls; process-tree PSS; scripted inference and real tools.',
                  'summary': summary, 'sourceChangePercent': changes, 'inputs': inputs}, indent=2))
