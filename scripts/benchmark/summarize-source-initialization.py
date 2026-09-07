#!/usr/bin/env python3
"""Compare source initialization changes with preserved baseline and fresh controls."""
import argparse, gzip, hashlib, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--before-layout', choices=['standard', 'baseline-minified'], default='baseline-minified')
parser.add_argument('--before-trials', type=int, nargs='+', required=True)
parser.add_argument('--after-trials', type=int, nargs='+', required=True)
parser.add_argument('--mode', choices=['request-cache', 'resident'], default='request-cache')
args = parser.parse_args()
if len(args.before_trials) != len(args.after_trials): parser.error('Trial groups must have equal lengths')
root = Path(__file__).resolve().parents[2]
groups = {name: [] for name in ['before', 'after', 'merged']}
inputs = []
expected_snapshot = None
matched = None
variant_hashes = {}
match_keys = ['environment', 'turns', 'sampleIntervalMs', 'benchmarkManifest', 'requestLauncherSha256',
              'samplerSha256', 'harnessSha256', 'dependencySnapshot', 'singleStartupLauncher']
for before, after in zip(args.before_trials, args.after_trials):
    before_backend = 'sdk-source' + ('' if args.before_layout == 'standard' else '-'+args.before_layout)
    for name, backend, trial in [('before', before_backend, before), ('after', 'sdk-source-minified', after), ('merged', 'sdk', after)]:
        path = root / f'artifacts/results/lifecycle-{backend}-{args.mode}-{trial}.json'
        if not path.exists(): path = path.with_suffix('.json.gz')
        raw = path.read_bytes()
        report = json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)
        snapshot = report.get('dependencySnapshot')
        if not snapshot: raise ValueError(f'Unfrozen dependencies: {path}')
        if expected_snapshot is None: expected_snapshot = snapshot['manifestSha256']
        if snapshot['manifestSha256'] != expected_snapshot: raise ValueError(f'Mixed dependency snapshots: {path}')
        if report['backend'] != ('sdk' if name == 'merged' else 'sdk-source') or report['mode'] != args.mode or report['trial'] != trial:
            raise ValueError(f'Mismatched report identity: {path}')
        if name != 'merged' and report['sourceLayout'] != (args.before_layout if name == 'before' else 'minified'):
            raise ValueError(f'Mismatched source layout: {path}')
        entry_hash = report['entrySha256']
        if name in variant_hashes and variant_hashes[name] != entry_hash: raise ValueError(f'Mixed core entries: {name}')
        variant_hashes[name] = entry_hash
        if matched is None: matched = report
        for key in match_keys:
            if report.get(key) != matched.get(key): raise ValueError(f'Unmatched {key}: {path}')
        if not report['valid']: raise ValueError(f'Invalid trial: {path}')
        if any('failed to asynchronously prepare wasm' in line or line.startswith('Aborted(')
               for run in report['runs'] for line in run['logs']):
            raise ValueError(f'Parser fallback: {path}')
        groups[name].append(report)
        inputs.append({'variant': name, 'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(raw).hexdigest()})

for name in ['before', 'after']:
    for key in ['sourceCoreSha256', 'sourceToolRuntimeSha256', 'sourceFixtureBuilderSha256']:
        if len({r[key] for r in groups[name]}) != 1: raise ValueError(f'Mixed source artifacts ({key}): {name}')
    for report in groups[name]:
        for prefix in ['sourceCore', 'sourceToolRuntime']:
            if report[prefix+'Manifest']['sha256'] != report[prefix+'Sha256']:
                raise ValueError(f'Stale source manifest ({prefix}): {name}')
if groups['before'][0]['sourceCoreSha256'] == groups['after'][0]['sourceCoreSha256']:
    raise ValueError('Before and after source artifacts must be distinct')

summary = {}
for name, reports in groups.items():
    metrics = {}
    for key in ['firstProcessMs', 'totalCpuSeconds', 'subsequentProcessMedianMs', 'subsequentCpuMedianSeconds',
                'peakPssMiB', 'warmTurnMedianMs', 'idleCorePssMiB']:
        values = [r['summary'][key] for r in reports if r['summary'][key] is not None]
        if values: metrics[key] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    if args.mode == 'request-cache':
        values = [r['runs'][0]['cpuSeconds'] for r in reports]
        metrics['firstProcessCpuSeconds'] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
        values = [statistics.median(run['peakPssMiB'] for run in r['runs'][1:]) for r in reports]
        metrics['cachedProcessPeakPssMiB'] = {'median': statistics.median(values), 'range': [min(values), max(values)]}
    metrics['maxProcessWallMs'] = max(run['wallMs'] for r in reports for run in r['runs'])
    summary[name] = metrics

def changes(reference):
    return {key: (summary['after'][key]['median'] / value['median'] - 1) * 100
            for key, value in summary[reference].items() if isinstance(value, dict) and value['median']}

print(json.dumps({
    'method': 'Three variants in one copied dependency snapshot. Medians of per-trial statistics; fresh empty compile cache per request-cache trial. All supplied trials included; execution order is recorded by the run plan.',
    'mode': args.mode, 'beforeLayout': args.before_layout,
    'snapshotManifestSha256': expected_snapshot, 'dependencySnapshot': matched['dependencySnapshot'], 'entryHashes': variant_hashes,
    'beforeTrials': args.before_trials, 'afterTrials': args.after_trials,
    'turns': sum(r['turns'] for reports in groups.values() for r in reports),
    'summary': summary, 'afterVsBeforePercent': changes('before'), 'afterVsMergedPercent': changes('merged'),
    'inputs': inputs,
    'summarizerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}, indent=2))
