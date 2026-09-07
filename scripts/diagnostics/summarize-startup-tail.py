#!/usr/bin/env python3
"""Attribute sampled main-thread profile time to measured startup phases."""
import argparse, bisect, collections, gzip, hashlib, json, statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('trial', type=int)
parser.add_argument('--compress-profiles', action='store_true', help='Preserve raw CPU profile bytes as gzip after reading them')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
paths = list((root / 'artifacts/results').glob(f'lifecycle-sdk-*-{args.trial}.json'))
if len(paths) != 1: raise RuntimeError('Expected one lifecycle report')
report = json.loads(paths[0].read_text())
if not report.get('valid') or not report.get('startupDiagnostics'): raise RuntimeError('Expected valid diagnostic run')
rows = []
for run in report['runs']:
    events = run['startupEvents']
    ready = next(e for e in events if e['phase'] == 'worker-ready')
    intervals = []
    for start, end in zip(events, events[1:]):
        if start['phase'] == 'worker-ready': break
        gc = events[-1].get('gc', [])
        intervals.append({'from': start['phase'], 'to': end['phase'],
            'wallMs': end['uptimeMs'] - start['uptimeMs'],
            'cpuMs': sum(end['cpu'].values()) / 1000 - sum(start['cpu'].values()) / 1000,
            'observedGcMs': sum(max(0, min(g['startMs'] + g['durationMs'], end['uptimeMs']) - max(g['startMs'], start['uptimeMs'])) for g in gc)})
    row = {'index': run['index'], 'workerReadyMs': ready['receivedAtMs'], 'wallMs': run['wallMs'], 'cpuSeconds': run['cpuSeconds'], 'intervals': intervals}
    if 'cpuProfile' in run:
        path = root / run['cpuProfile']
        compressed = Path(str(path) + '.gz')
        data = path.read_bytes() if path.exists() else gzip.decompress(compressed.read_bytes())
        if args.compress_profiles and path.exists():
            if compressed.exists() and gzip.decompress(compressed.read_bytes()) != data: raise RuntimeError('Conflicting compressed profile')
            compressed.write_bytes(gzip.compress(data, mtime=0))
            path.unlink()
        storage = path if path.exists() else compressed
        profile = json.loads(data)
        if not profile['startTime'] <= events[0]['monotonicUs'] < ready['monotonicUs'] < profile['endTime']:
            raise RuntimeError('Profile and phase clocks are not aligned')
        frames = {n['id']: n['callFrame'] for n in profile['nodes']}
        times = [e['monotonicUs'] for e in events]
        totals = collections.Counter(); by_phase = collections.defaultdict(collections.Counter)
        stamp = profile['startTime']; negative_intervals = []
        if len(profile['samples']) != len(profile['timeDeltas']): raise RuntimeError('Mismatched profile sample arrays')
        for node, delta in zip(profile['samples'], profile['timeDeltas']):
            stamp += delta
            if stamp > ready['monotonicUs']: break
            # Preserve the original sample clock, but never assign negative
            # self time. Record backwards sample jitter instead of hiding it.
            if delta < 0: negative_intervals.append(delta)
            i = bisect.bisect_right(times, stamp) - 1
            phase = events[i]['phase'] if i >= 0 else 'before-preload'
            totals[node] += max(0, delta) / 1000
            by_phase[phase][node] += max(0, delta) / 1000
        def top(counter):
            return [{'sampledMs': ms, **frames[node]} for node, ms in counter.most_common(12)]
        row.update(cpuProfile=str(storage.relative_to(root)), profileSha256=hashlib.sha256(data).hexdigest(), negativeSampleIntervalsUs=negative_intervals,
                   topStartupFrames=top(totals), framesByPhase={phase: top(counter) for phase, counter in by_phase.items()})
    rows.append(row)
warm = rows[1:]
warm_median = statistics.median(r['workerReadyMs'] for r in warm)
result = {'trial': args.trial, 'diagnostics': report['startupDiagnostics'],
    'method': 'Phase wall/CPU differences plus sampled main-thread self time before worker-ready. CPU profiles perturb startup and exclude background-thread stacks. GC observer intervals are not a complete V8 native allocation trace.',
    'summary': {'requests': len(rows), 'firstReadyMs': rows[0]['workerReadyMs'],
                'warmReadyMedianMs': warm_median,
                'warmReadyMaxMs': max(r['workerReadyMs'] for r in warm),
                'warmReadyMaxToMedianRatio': max(r['workerReadyMs'] for r in warm) / warm_median,
                'warmReadyAbove2xMedian': sum(r['workerReadyMs'] > 2 * warm_median for r in warm)}, 'runs': rows}
output = root / f'artifacts/results/startup-tail-summary-{args.trial}.json'
output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
print(json.dumps(result['summary']))
for row in sorted(rows, key=lambda r: r['workerReadyMs'], reverse=True)[:3]:
    print(json.dumps({k: row[k] for k in ['index', 'workerReadyMs', 'intervals']}))
