#!/usr/bin/env python3
"""Profile one cached request per core; these instrumented runs are not benchmarks."""
import argparse, gzip, hashlib, json, os, subprocess, tempfile
from collections import defaultdict
from pathlib import Path

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True, help='New profile directory; existing evidence is never overwritten')
args = parser.parse_args()
output = (root / args.output).resolve()
output.mkdir(exist_ok=False)
cpus = sorted(os.sched_getaffinity(0))[:2]
results = []
for name, entry in [('merged', 'native-sdk-core-benchmark.mjs'), ('source-minified', 'minified-source-native-sdk-core-benchmark.mjs')]:
    with tempfile.TemporaryDirectory(prefix='source-profile-') as directory:
        base = Path(directory)
        for part in ['workspace', 'state', 'cache']: (base / part).mkdir()
        env = os.environ.copy()
        for key in ['NODE_OPTIONS','NODE_DISABLE_COMPILE_CACHE','BENCH_NATIVE_MEMORY','BENCH_GC_AT_IDLE','BENCH_PROFILE_CORE','BENCH_SPLIT_INIT','AGENTOS_LINUX_EXPERIMENT']:
            env.pop(key, None)
        env.update(BENCH_ROOT=directory, BENCH_WORKLOAD='core-workload', BENCH_WARM_TURNS='0',
                   NODE_COMPILE_CACHE=str(base/'cache'), OPENCLAW_STATE_DIR=str(base/'state/openclaw'),
                   OPENCLAW_CHILD_OOM_SCORE_ADJ='0', AGENTOS_SDK_FILESYSTEM='node')
        for turn in [0, 1]:
            env['BENCH_REQUEST_TURN'] = str(turn)
            flags = ['--cpu-prof', '--cpu-prof-interval=1000', f'--cpu-prof-dir={output}', f'--cpu-prof-name={name}.cpuprofile'] if turn else []
            run = subprocess.run(['sh', 'scripts/run-core-node-request.sh', *flags, f'artifacts/core/{entry}', '--internal-worker-prewarm'], cwd=root, env=env, text=True, capture_output=True, timeout=120, preexec_fn=lambda: os.sched_setaffinity(0, cpus))
            if run.returncode or 'failed to asynchronously prepare wasm' in run.stderr:
                raise RuntimeError(run.stdout + run.stderr)
            events = [json.loads(line[12:]) for line in run.stdout.splitlines() if line.startswith('BENCH_EVENT=')]
            complete = next(event for event in events if event['label'] == 'representative:complete')
            assert complete['nextTurn'] == turn + 1 and complete['toolCounts'] == {'read':1,'exec':2,'edit':1,'write':1}
        checkpoint = json.loads((base/'state/request-checkpoint.json').read_text())
        assert checkpoint['nextTurn'] == 2 and len(checkpoint['messages']) == 48
    path = output / f'{name}.cpuprofile'
    raw = path.read_bytes()
    profile = json.loads(raw)
    nodes = {node['id']:node['callFrame'] for node in profile['nodes']}
    totals = defaultdict(float)
    for node, delta in zip(profile['samples'], profile['timeDeltas']):
        frame = nodes[node]
        key = (frame['functionName'] or '(anonymous)', frame['url'])
        totals[key] += delta / 1000
    compressed = path.with_suffix('.cpuprofile.gz')
    compressed.write_bytes(gzip.compress(raw, mtime=0))
    assert gzip.decompress(compressed.read_bytes()) == raw
    path.unlink()
    results.append({'core':name,'entrySha256':hashlib.sha256((root/f'artifacts/core/{entry}').read_bytes()).hexdigest(),
                    'profile':str(compressed.relative_to(root)), 'sha256':hashlib.sha256(compressed.read_bytes()).hexdigest(),
                    'topSelfSamples':[{'function':key[0], 'url':key[1], 'sampledMs':value} for key,value in sorted(totals.items(), key=lambda item:item[1], reverse=True)[:30]]})
report = {'note':'One instrumented cached request after priming per core; self-sample wall intervals are diagnostic, not matched CPU benchmarks. Spawned tool CPU is absent from these core-only profiles.', 'cpus':cpus, 'results':results}
(output/'summary.json').write_text(json.dumps(report, indent=2)+'\n')
subprocess.run(['node', 'scripts/diagnostics/map-source-profile.mjs', str(output)], cwd=root, check=True)
print(json.dumps(report, indent=2))
