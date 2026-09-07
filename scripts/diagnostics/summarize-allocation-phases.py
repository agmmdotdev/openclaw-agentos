#!/usr/bin/env python3
"""Summarize GC observations separately from allocation-sampled runs."""
import argparse, gzip, hashlib, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('trials', type=int, nargs=2)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
summary = []
for trial in args.trials:
    path = root / f'artifacts/results/lifecycle-sdk-request-cache-{trial}.json'
    if not path.exists(): path = path.with_suffix('.json.gz')
    raw = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
    report = json.loads(raw)
    assert report['valid'] and report['startupDiagnostics']['mode'] == 'phases'
    rows = []
    for run in report['runs']:
        events = {e['phase']: e for e in run['startupEvents']}
        start, end = events['preload']['uptimeMs'], events['worker-ready']['uptimeMs']
        gc = [g for g in events['before-exit']['gc'] if g['startMs'] < end and g['startMs'] + g['durationMs'] > start]
        rows.append({'index': run['index'], 'readyMs': end, 'startupGcCount': len(gc),
                     'startupGcMs': sum(max(0, min(end, g['startMs'] + g['durationMs']) - max(start, g['startMs'])) for g in gc),
                     'embeddedInitMs': events['embedded-init:end']['uptimeMs'] - events['embedded-init:start']['uptimeMs']})
    summary.append({'trial': trial, 'reportSha256': hashlib.sha256(raw).hexdigest(), 'runs': rows,
                    'warmMedians': {k: statistics.median(v[k] for v in rows[1:]) for k in ['readyMs', 'startupGcCount', 'startupGcMs', 'embeddedInitMs']}})
print(json.dumps({'note': 'Phase-only diagnostics. GC duration is clipped to preload through worker-ready; no allocation sampling. Not a performance comparison or a complete native GC trace.', 'trials': summary}, indent=2))
