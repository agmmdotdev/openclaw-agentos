#!/usr/bin/env python3
"""Compare source initialization changes with preserved baseline and fresh controls."""
import argparse, gzip, hashlib, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--before-layout', default='baseline-minified')
parser.add_argument('--before-trials', type=int, nargs='+', required=True)
parser.add_argument('--after-trials', type=int, nargs='+', required=True)
args = parser.parse_args()
if len(args.before_trials) != len(args.after_trials): parser.error('Trial groups must have equal lengths')
root = Path(__file__).resolve().parents[2]
groups = {name: [] for name in ['before', 'after', 'merged']}
inputs = []
for before, after in zip(args.before_trials, args.after_trials):
    block = []
    for name, backend, trial in [('before', 'sdk-source-'+args.before_layout, before), ('after', 'sdk-source-minified', after), ('merged', 'sdk', after)]:
        path = root / f'artifacts/results/lifecycle-{backend}-request-cache-{trial}.json'
        if not path.exists(): path = path.with_suffix('.json.gz')
        raw = path.read_bytes()
        report = json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)
        if not report['valid']: raise ValueError(f'Invalid trial: {path}')
        if any('failed to asynchronously prepare wasm' in line or line.startswith('Aborted(')
               for run in report['runs'] for line in run['logs']):
            raise ValueError(f'Parser fallback: {path}')
        groups[name].append(report)
        block.append(report)
        inputs.append({'variant': name, 'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(raw).hexdigest()})
    for key in ['environment', 'turns', 'sampleIntervalMs', 'benchmarkManifest', 'requestLauncherSha256', 'samplerSha256', 'harnessSha256']:
        if any(report[key] != block[0][key] for report in block[1:]): raise ValueError(f'Unmatched {key}: {before}/{after}')

for name in ['before', 'after']:
    hashes = {r['sourceCoreSha256'] for r in groups[name]}
    if len(hashes) != 1: raise ValueError(f'Mixed source artifacts: {name}')
if groups['before'][0]['sourceCoreSha256'] == groups['after'][0]['sourceCoreSha256']:
    raise ValueError('Before and after source artifacts must be distinct')

summary = {}
for name, reports in groups.items():
    metrics = {}
    for key in ['totalCpuSeconds', 'subsequentProcessMedianMs', 'subsequentCpuMedianSeconds', 'peakPssMiB']:
        values = [r['summary'][key] for r in reports]
        metrics[key] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    values = [statistics.median(run['peakPssMiB'] for run in r['runs'][1:]) for r in reports]
    metrics['cachedProcessPeakPssMiB'] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    metrics['maxProcessWallMs'] = max(run['wallMs'] for r in reports for run in r['runs'])
    summary[name] = metrics

def changes(reference):
    return {key: (summary['after'][key]['median'] / value['median'] - 1) * 100
            for key, value in summary[reference].items() if isinstance(value, dict) and value['median']}

print(json.dumps({
    'method': 'Three variants measured serially in rotating order. Medians of per-trial statistics; fresh empty compile cache per trial. All trials included.',
    'beforeTrials': args.before_trials, 'afterTrials': args.after_trials,
    'turns': sum(r['turns'] for reports in groups.values() for r in reports),
    'summary': summary, 'afterVsBeforePercent': changes('before'), 'afterVsMergedPercent': changes('merged'),
    'inputs': inputs,
}, indent=2))
