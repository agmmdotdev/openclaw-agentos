#!/usr/bin/env python3
"""Summarize workload decomposition; distinguish inclusive CPU from legacy samples."""
import json, statistics
from pathlib import Path
root = Path(__file__).resolve().parents[2]
folder = root / 'artifacts/results'
runs = []
for path in sorted(folder.glob('benchmark-*.json')):
    if path.name in ('benchmark-summary.json', 'benchmark-bottlenecks.json'): continue
    report = json.loads(path.read_text())
    workload = report.get('diagnostics', {}).get('BENCH_WORKLOAD')
    if workload is None or not report.get('measurementValid', True) or not report['events']: continue
    events, samples = report['events'], report['samples']
    clock_offset = min(e['receivedAtMs']-e['atMs'] for e in events)
    def event_time(e): return e['atMs'] + clock_offset
    hz = report['environment']['clockTicksPerSecond']
    inclusive = all('accountedTreeTicks' in s for s in samples)
    trace, seen, high = [], {}, 0
    for sample in samples:
        if inclusive:
            # Reaped-child CPU rolls into its live parent. Count only currently
            # live processes, then retain a high-water mark across sample races.
            high = max(high, sample['accountedTreeTicks'])
        else:
            for p in sample['processes']:
                key = (p['pid'], p['startTicks'])
                seen[key] = max(seen.get(key, 0), p['ticks'])
            high = sum(seen.values())
        trace.append((sample['atMs'], high / hz))
    def event(label):
        return next((e for e in events if e['label'] == label), None)
    def cpu_at(t):
        return min(trace, key=lambda item: abs(item[0] - t))[1]
    def phase(start, end):
        a, b = event(start), event(end)
        if a is None or b is None: return None
        memory = [s['pssBytes']/2**20 for s in samples if event_time(a) <= s['atMs'] <= event_time(b)]
        return {'cpuSeconds': max(0, cpu_at(event_time(b)) - cpu_at(event_time(a))),
                'hostElapsedMs': event_time(b)-event_time(a),
                'peakPssMiB': max(memory) if memory else None}
    boundaries = []
    for e in events:
        if not e['label'].startswith('boundary:') or not e['label'].endswith(':end'): continue
        prefix=e['label'][:-4]
        boundaries.append({'name':e['label'].split(':')[1], 'phase':e['label'].split(':')[2],
            'iterations': e['iterations'], 'checksum':e['checksum'], 'batchMs':e['durationMs'],
            'meanMs':e['durationMs']/e['iterations'], 'medianMs':statistics.median(e['times']),
            **phase(prefix+':start',prefix+':end')})
    warm=[e for e in events if e['label'].startswith('warm-turn-') and e['label'].endswith(':end')]
    turns=None
    if warm:
        turns={'warmCount':len(warm),'warmMedianMs':statistics.median(e['durationMs'] for e in warm),
            'warmMeanMs':statistics.mean(e['durationMs'] for e in warm),
            'warm':phase('warm-turn-1:start',warm[-1]['label']),
            'cold':phase('cold-turn:start','cold-turn:end'),
            'finalTranscriptMessages':warm[-1]['transcriptMessages'],
            'callsPerTurn':warm[-1]['calls']}
        if 'sqliteCalls' in warm[-1]:
            turns['warmSqlCalls']=warm[-1]['sqliteCalls']-event('warm-turn-1:start')['sqliteCalls']
            turns['warmHostSqlMs']=warm[-1]['hostSqlMilliseconds']-event('warm-turn-1:start')['hostSqlMilliseconds']
    runs.append({'file':path.name,'runtime':report['runtime'],'workload':workload,
        'reverse':report['diagnostics'].get('BENCH_REVERSE')=='1', 'passed':report['exitCode']==0,
        'cpuIncludesReapedChildren':inclusive,'lifecycleCpuSeconds':high/hz,
        'turns':turns,'boundaries':boundaries})
result={'method':{'cpu':'Event monotonic timestamps aligned by minimum receive offset to avoid stdout-buffering skew; nearest 100 ms process-tree samples, including reaped children where indicated; short native phases may be below resolution. Legacy runs are exploratory only.',
    'workloads':'Core modes change only the allowed/requested tools and expected response counts. Boundary cases bypass the OpenClaw turn while loading the same reduced artifact.',
    'scope':'Local deterministic inference. Do not compare different workloads as equivalent functionality or infer engine-internal attribution from these intervals.'},'runs':runs}
(folder/'benchmark-bottlenecks.json').write_text(json.dumps(result,indent=2)+'\n')
for r in runs:
    print(r['file'],r['workload'],'PASS' if r['passed'] else 'FAIL','inclusiveCPU',r['cpuIncludesReapedChildren'])
    if r['turns']:
        t=r['turns'];print('  warm median ms',round(t['warmMedianMs'],2),'warm CPU-s',round(t['warm']['cpuSeconds'],2))
    for b in r['boundaries']:
        if b['phase']=='warm':print(' ',b['name'],'mean ms',round(b['meanMs'],3),'batch CPU-s',round(b['cpuSeconds'],2))
