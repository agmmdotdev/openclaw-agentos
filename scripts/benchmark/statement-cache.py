#!/usr/bin/env python3
"""Summarize the retained statement-cache experiment; no benchmark is rerun."""
import json
import statistics
from pathlib import Path

folder = Path(__file__).resolve().parents[2] / 'artifacts/results'
rows = []
for trial in [104, 105, 106, 107]:
    path = folder / f'benchmark-1vm-{trial}.json'
    report = json.loads(path.read_text())
    assert report['measurementValid'] and report['instances'] == 1
    events = {event['label']: event for event in report['events']}
    cold, warm = events['cold-turn:end'], events['warm-turn-50:end']
    offset = min(event['receivedAtMs'] - event['atMs'] for event in report['events'])
    high = 0
    cpu = []
    for sample in report['samples']:
        high = max(high, sample['accountedTreeTicks'])
        cpu.append((sample['atMs'], high / report['environment']['clockTicksPerSecond']))
    def cpu_at(label):
        timestamp = events[label]['atMs'] + offset
        return min(cpu, key=lambda sample: abs(sample[0] - timestamp))[1]
    idle = [sample['pssBytes'] / 2**20 for sample in report['samples']
            if events['idle:start']['receivedAtMs'] <= sample['atMs'] < events['idle:end']['receivedAtMs']]
    rows.append({
        'file': path.name, 'recordedAt': report['recordedAt'],
        'cacheSize': report['sqlStatementCacheSize'],
        'launchToFirstMs': cold['atMs'] - events['launch:start']['atMs'],
        'warmMedianMs': statistics.median(event['durationMs'] for label, event in events.items()
                                         if label.startswith('warm-turn-') and label.endswith(':end')),
        'warmCpuSeconds': max(0, cpu_at('warm-turn-50:end') - cpu_at('warm-turn-1:start')),
        'idlePssMiB': statistics.median(idle), 'peakPssMiB': report['peakPssBytes'] / 2**20,
        'coldHostSqlMs': cold['hostSqlMilliseconds'],
        'warmHostSqlMs': warm['hostSqlMilliseconds'] - cold['hostSqlMilliseconds'],
        'sqliteCallsThroughTurns': warm['sqliteCalls'],
        'sqliteIncludingTeardown': events['process:end']['sqlite'],
    })
result = {
    'scope': 'Two runs per configuration; one cold plus 50 warm read-and-shell turns. '
             'Trial 107 resumed in a later session; not an uninterrupted ABBA experiment. '
             'CPU uses nearest process-tree samples with reaped-child accounting. '
             'These runs do not establish a full-workload performance improvement.',
    'excluded': {'101': 'preliminary control', '102': 'initial candidate overlapped typecheck/tests',
                 '103': 'earlier cache eligibility rules'},
    'runs': rows,
}
(folder / 'statement-cache-comparison.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
