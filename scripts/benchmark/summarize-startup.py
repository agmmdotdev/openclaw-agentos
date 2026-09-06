#!/usr/bin/env python3
"""Summarize the explicitly selected, paired startup comparison trials."""
import argparse, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, required=True)
parser.add_argument('--output', default='native-startup-summary.json')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
if Path(args.output).name != args.output:
    parser.error('Output must be a filename')
reports = []
for trial in args.trials:
    matches = list((root / 'artifacts/results').glob(f'lifecycle-sdk-*-{trial}.json'))
    if len(matches) != 1:
        raise RuntimeError(f'Expected exactly one report for trial {trial}')
    report = json.loads(matches[0].read_text())
    if not report['valid'] or report['turns'] != 7:
        raise RuntimeError(f'Invalid comparison trial {trial}')
    reports.append(report)
if len({r['entrySha256'] for r in reports}) != 1:
    raise RuntimeError('Comparison entry changed')
groups = []
for mode in ['request-cache', 'resident']:
    for profile in ['default', 'request']:
        selected = [r for r in reports if r['mode'] == mode and r['environment']['profile'] == profile]
        if len(selected) != 3:
            raise RuntimeError(f'Expected three trials for {mode}/{profile}')
        metrics = {}
        for key in selected[0]['summary']:
            values = [r['summary'][key] for r in selected]
            metrics[key] = None if any(v is None for v in values) else {
                'median': statistics.median(values), 'min': min(values), 'max': max(values),
            }
        groups.append({'mode': mode, 'profile': profile, 'trials': [r['trial'] for r in selected], 'metrics': metrics})
result = {'method': 'Three serial paired trials per mode/profile; seven turns and 35 real tools each; 420 ms scripted inference per turn; external controller excluded; cache starts empty per trial. Values are medians and ranges of per-trial summaries.',
          'entrySha256': reports[0]['entrySha256'], 'groups': groups}
path = root / 'artifacts/results' / args.output
path.write_text(json.dumps(result, indent=2) + '\n')
print(path)
