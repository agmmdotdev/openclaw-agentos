#!/usr/bin/env python3
"""Attribute sampled startup allocations, including collected objects.

Estimates are not live heap bytes, native allocations, or performance results.
"""
import argparse, collections, gzip, hashlib, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('trial', type=int)
args = parser.parse_args()
report_path = ROOT / f'artifacts/results/lifecycle-sdk-request-cache-{args.trial}.json'
if not report_path.exists(): report_path = report_path.with_suffix('.json.gz')
report = json.loads(gzip.decompress(report_path.read_bytes()) if report_path.suffix == '.gz' else report_path.read_bytes())
assert report['valid'] and report['startupDiagnostics']['mode'] == 'allocations'
source = ROOT / f'artifacts/core/startup-tail-{args.trial}.mjs'
assert hashlib.sha256(source.read_bytes()).hexdigest() == report['entrySha256']
lines = source.read_text().split('\n')
rows = []
for run in report['runs']:
    path = ROOT / run['allocationProfile']
    raw = gzip.decompress(path.read_bytes())
    logs = [json.loads(line.removeprefix('STARTUP_ALLOCATIONS=')) for line in run['logs'] if line.startswith('STARTUP_ALLOCATIONS=')]
    assert len(logs) == 1 and logs[0]['sha256'] == hashlib.sha256(raw).hexdigest()
    payload = json.loads(raw)
    assert payload['endPhase'] == 'worker-ready'
    assert payload['options']['includeObjectsCollectedByMajorGC']
    assert payload['options']['includeObjectsCollectedByMinorGC']
    assert payload['node'] == report['environment']['node']
    profile = payload['profile']
    attribution, self_frames, schema_callers = collections.Counter(), collections.Counter(), collections.Counter()
    nodes = {}

    def walk(node, owner='runtime/other', schema_caller=None):
        frame = node['callFrame']
        url, line = frame['url'], frame['lineNumber']
        label = f"{frame['functionName'] or '(anonymous)'} {url.rsplit('/', 1)[-1]}:{line + 1}"
        if url.endswith(source.name) and 0 <= line < len(lines):
            match = re.match(r'var ([\w$]+)=(?:__esmMin|__commonJSMin)\(', lines[line])
            if match:
                owner = match[1]
                if owner.startswith('init_zod_schema_'): schema_caller = owner
            elif owner == 'runtime/other':
                owner = 'core/other'
        nodes[node['id']] = (owner, label, schema_caller)
        for child in node.get('children', []):
            walk(child, owner, schema_caller)

    walk(profile['head'])
    # Sample sizes already contain V8's statistical weighting; do not multiply
    # by samplingInterval or call counts. Each sample is counted exactly once.
    for sample in profile['samples']:
        owner, label, schema_caller = nodes[sample['nodeId']]
        if schema_caller: schema_callers[schema_caller] += sample['size']
        attribution[owner] += sample['size']
        self_frames[label] += sample['size']
    rows.append({'index': run['index'], 'profile': str(path.relative_to(ROOT)),
                 'rawSha256': hashlib.sha256(raw).hexdigest(),
                 'sampleCount': len(profile['samples']),
                 'estimatedAllocatedMiB': sum(attribution.values()) / 2**20,
                 'ownersMiB': {k: v / 2**20 for k, v in attribution.most_common()},
                 'schemaCallersMiB': {k: v / 2**20 for k, v in schema_callers.most_common()},
                 'topSelfFramesMiB': {k: v / 2**20 for k, v in self_frames.most_common(30)}})
output = ROOT / f'artifacts/results/startup-allocations-{args.trial}.json'
with output.open('w') as f:
    json.dump({'trial': args.trial, 'instrumented': True, 'sourceSha256': report['entrySha256'],
               'note': 'Sampled JavaScript allocations through worker-ready, including GC-collected objects; not live heap or total native allocation. Initializer attribution uses the nearest matching generated initializer frame.',
               'runs': rows}, f, indent=2)
    f.write('\n')
for row in rows:
    print(json.dumps({'index': row['index'], 'estimatedAllocatedMiB': row['estimatedAllocatedMiB'], 'schemaCallersMiB': row['schemaCallersMiB']}))
