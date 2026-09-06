#!/usr/bin/env python3
"""Linux process-tree RSS/PSS sampling, outside the measured Node process."""
import argparse, json, os, platform, resource, selectors, signal, subprocess, time, tempfile, shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--instances', type=int, default=1, choices=[1, 2, 4])
parser.add_argument('--trial', type=int, default=1)
parser.add_argument('--cpus', type=int, help='Restrict the measured process tree to this many currently allowed Linux CPUs')
parser.add_argument('--interval', type=float, default=0.1)
parser.add_argument('--native', action='store_true')
parser.add_argument('--node-max-opt', type=int, choices=[0, 1, 2, 3], help='Diagnostic host V8 maximum compiler tier; requires revalidation on Node upgrades')
parser.add_argument('--node-semi-space-mb', type=int, choices=[1, 2, 4, 8, 16, 32, 64], help='Host Node young-generation semi-space cap; does not change guest V8 limits')
parser.add_argument('--native-sdk', action='store_true', help='TRUSTED-ONLY extracted SDK; not a Linux sandbox')
parser.add_argument('--wasmer', action='store_true', help='Native core with Wasmer SDK tools; requires --native --core')
parser.add_argument('--hybrid', action='store_true', help='Trusted native core with agentOS tools; requires --native --core')
parser.add_argument('--compiled', action='store_true', help='Use the lowered native Node baseline; requires --native')
parser.add_argument('--core', action='store_true', help='Use the smaller native core; requires --native')
parser.add_argument('--allocator', choices=['default', 'compact'], default='default', help='compact: glibc arena/trim settings, applied equally to host and descendants')
args = parser.parse_args()
if args.native_sdk and (not (args.native and args.core) or args.hybrid or args.wasmer): parser.error('--native-sdk requires --native --core without another backend')
if args.native_sdk and os.environ.get('AGENTOS_LINUX_EXPERIMENT') == '1': parser.error('Experimental Linux execution is a host correctness probe, not an accepted performance configuration')
if args.wasmer and (not (args.native and args.core) or args.hybrid): parser.error('--wasmer requires --native --core without --hybrid')
if args.hybrid and not (args.native and args.core): parser.error('--hybrid requires --native --core')
if args.core and (not args.native or args.compiled): parser.error('--core requires --native without --compiled')
if args.compiled and not args.native: parser.error('--compiled requires --native')
root = Path(__file__).resolve().parents[2]
if args.core and json.loads((root / 'artifacts/core/manifest.json').read_text()).get('profile') != 'core':
    parser.error('--core requires a reduced core build')
native_label = 'native-sdk-trusted-core' if args.native_sdk else 'wasmer-native-core' if args.wasmer else 'hybrid-native-core' if args.hybrid else 'native-core' if args.core else 'native-compiled' if args.compiled else 'native'
output = root / (f'artifacts/results/benchmark-{native_label}-{args.trial}.json' if args.native else f'artifacts/results/benchmark-{args.instances}vm-{args.trial}.json')

if output.exists(): parser.error(f'Result already exists: {output}; choose a new trial')
if args.interval <= 0: parser.error('--interval must be positive')
try:
    warm_turns = int(os.environ.get('BENCH_WARM_TURNS', '5'))
except ValueError:
    parser.error('BENCH_WARM_TURNS must be an integer')
if not 1 <= warm_turns <= 100: parser.error('BENCH_WARM_TURNS must be between 1 and 100')

from process_metrics import proc_info, sample

def read_optional(path):
    try: return Path(path).read_text().strip()
    except OSError: return None

allowed_cpus = sorted(os.sched_getaffinity(0))
if args.cpus is not None and not 1 <= args.cpus <= len(allowed_cpus): parser.error('--cpus exceeds the available CPU affinity')
selected_cpus = allowed_cpus[:args.cpus] if args.cpus else allowed_cpus

before = resource.getrusage(resource.RUSAGE_CHILDREN)
started = time.monotonic()
native_root = tempfile.mkdtemp(prefix='openclaw-native-bench-') if args.native else None
env = os.environ.copy()
if args.allocator == 'compact':
    if platform.libc_ver()[0] != 'glibc': parser.error('compact allocator profile requires glibc')
    env.update(MALLOC_ARENA_MAX='1', MALLOC_TRIM_THRESHOLD_='65536', MALLOC_MMAP_THRESHOLD_='65536')
if native_root:
    for directory in ['workspace', 'state']: Path(native_root, directory).mkdir()
    env.update(BENCH_ROOT=native_root, OPENCLAW_STATE_DIR=f'{native_root}/state/openclaw', OPENCLAW_CHILD_OOM_SCORE_ADJ='0')
native_entry = 'artifacts/core/native-core-benchmark.mjs' if args.core else 'artifacts/core/native-compiled-benchmark.mjs' if args.compiled else 'artifacts/core/native-benchmark.mjs'
if args.hybrid: native_entry = 'artifacts/core/hybrid-core-benchmark.mjs'
if args.native_sdk: native_entry = 'artifacts/core/native-sdk-core-benchmark.mjs'
if args.wasmer: native_entry = 'artifacts/core/wasmer-core-benchmark.mjs'
command = ['node', '--expose-gc', native_entry, '--internal-worker-prewarm'] if args.native else ['node', '--expose-gc', 'scripts/benchmark/driver.mjs', str(args.instances)]
if args.wasmer: command.insert(1, '--experimental-wasm-jspi')
if args.node_semi_space_mb is not None: command.insert(1, f'--max-semi-space-size={args.node_semi_space_mb}')
if args.node_max_opt is not None: command.insert(1, f'--max-opt={args.node_max_opt}')
process = subprocess.Popen(command, cwd=root, env=env,
    preexec_fn=(lambda: os.sched_setaffinity(0, selected_cpus)) if args.cpus else None,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
# This environment mounts a /proc from an outer PID namespace. Popen.pid is
# local to our namespace; resolve its visible PID through parentage + NSpid.
parent_proc_pid = int(os.readlink('/proc/self'))
proc_pid = None
for entry in Path('/proc').iterdir():
    if not entry.name.isdigit(): continue
    try:
        info = proc_info(int(entry.name))
        if info['ppid'] != parent_proc_pid: continue
        nspid = next(line for line in (entry / 'status').read_text().splitlines() if line.startswith('NSpid:'))
        if int(nspid.split()[-1]) == process.pid: proc_pid = int(entry.name); break
    except (OSError, ValueError, StopIteration): pass
if proc_pid is None:
    process.kill(); process.wait()
    raise RuntimeError('Cannot resolve benchmark PID in mounted /proc')
selector = selectors.DefaultSelector()
for stream, name in [(process.stdout, 'stdout'), (process.stderr, 'stderr')]:
    os.set_blocking(stream.fileno(), False)
    selector.register(stream, selectors.EVENT_READ, name)
buffers = {'stdout': b'', 'stderr': b''}
events, samples, stderr = [], [], []
next_sample = started
try:
    while selector.get_map() or process.poll() is None:
        now = time.monotonic()
        if now - started > 240:
            raise TimeoutError('Benchmark exceeded 240 seconds')
        if now >= next_sample:
            samples.append({'atMs': (now - started) * 1000, **sample(proc_pid)})
            next_sample = now + args.interval
        for key, _ in selector.select(timeout=max(0, min(0.1, next_sample - time.monotonic()))):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            name = key.data
            buffers[name] += chunk
            while b'\n' in buffers[name]:
                line, buffers[name] = buffers[name].split(b'\n', 1)
                text = line.decode(errors='replace')
                if name == 'stdout' and text.startswith('BENCH_EVENT='):
                    event = json.loads(text[len('BENCH_EVENT='):])
                    event['receivedAtMs'] = (time.monotonic() - started) * 1000
                    events.append(event)
                    if event['label'].startswith('boundary:') and event['label'].endswith(':end') or event['label'] == f"warm-turn-{env.get('BENCH_WARM_TURNS', '5')}:end" or event['label'] in ('worker-ready', 'cold-turn:end', 'warm-turn-5:end', 'error'):
                        print(json.dumps({k:v for k,v in event.items() if k != 'times'}), flush=True)
                else: stderr.append(text)
    exit_code = process.wait()
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    selector.close()
    if native_root: shutil.rmtree(native_root)
after = resource.getrusage(resource.RUSAGE_CHILDREN)
if not any(s['pssBytes'] > 0 for s in samples):
    raise RuntimeError('No valid memory samples; refuse to report zero memory')
cpu_ticks = {}
for item in samples:
    for member in item['processes']:
        key = (member['pid'], member['startTicks'])
        cpu_ticks[key] = max(cpu_ticks.get(key, 0), member['ticks'])
required_labels = {'worker-ready', 'idle:end'}
if env.get('BENCH_WORKLOAD') == 'boundaries':
    required_labels.update(f'boundary:{name}:warm:end' for name in ['js-cpu', 'fs-read', 'fs-read-root', 'direct-cat', 'shell-cat', 'shell-builtin', 'child-node'])
else:
    required_labels.update(['cold-turn:end', f'warm-turn-{warm_turns}:end'])
if env.get('BENCH_WORKLOAD') == 'core-workload':
    required_labels.add('representative:complete')
    required_labels.update(f'warm-turn-{turn}:end' for turn in range(1, warm_turns + 1))
missing_labels = sorted(required_labels - {e['label'] for e in events})
report = {
    'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'instances': args.instances, 'trial': args.trial, 'sampleIntervalMs': args.interval * 1000,
    'nodeSemiSpaceMiB': args.node_semi_space_mb, 'nodeMaxOpt': args.node_max_opt,
    'nativeSdk': {'security':'trusted-only', 'sandboxed':False, 'processTreeLimits':False, 'filesystemBackend':os.environ.get('AGENTOS_SDK_FILESYSTEM','node')} if args.native_sdk else None,
    'wasmer': {'sdkVersion': '0.11.0', 'package': 'wasmer/edgejs@0.2.0', 'parallelism': 2, 'experimentalWasmJspi': True, 'filesystem': 'in-memory', 'cacheDirectory': env.get('WASMER_CACHE_DIR', '/tmp/openclaw-wasmer-cache')} if args.wasmer else None,
    'runtime': native_label if args.native else 'agentos', 'splitInitializer': env.get('BENCH_SPLIT_INIT') == '1',
    'sqlStatementCacheSize': int(env.get('BENCH_SQL_STATEMENT_CACHE', '0')),
    'dataMount': env.get('BENCH_DATA_MOUNT', 'chunked_local'),
    'idleMs': int(env.get('BENCH_IDLE_MS', '1500')),
    'allocatorEnvironment': {k: env.get(k) for k in ['MALLOC_ARENA_MAX', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_MMAP_THRESHOLD_', 'MALLOC_TOP_PAD_', 'GLIBC_TUNABLES']},
    'benchmarkManifest': json.loads((root / 'artifacts/core/benchmark-manifest.json').read_text()) if (root / 'artifacts/core/benchmark-manifest.json').exists() else None,
    'coreManifest': json.loads((root / 'artifacts/core/manifest.json').read_text()),
    'diagnostics': {k: env.get(k, '0') for k in ['BENCH_NATIVE_MEMORY', 'BENCH_GC_AT_IDLE', 'BENCH_PROFILE_CORE', 'BENCH_PROFILE_FS', 'BENCH_SQL_SCHEMA_MODE', 'BENCH_PROFILE_PROCESS', 'BENCH_PROFILE_SQL']} | {k: env.get(k) for k in ['CORE_HEAP_MB', 'CORE_WASM_HEAP_MB', 'AGENTOS_V8_WARM_ISOLATES', 'AGENTOS_WASM_SNAPSHOT_RUNNER', 'BENCH_WARM_TURNS', 'BENCH_WORKLOAD', 'BENCH_REVERSE', 'BENCH_CORE_MOUNT', 'BENCH_CANONICAL_BATCHING']},
    'method': 'Linux smaps_rollup RSS/PSS summed across isolated benchmark driver and descendants; compiler runs separately',
    'environment': {'platform': platform.platform(), 'cpuCount': os.cpu_count(), 'cpuAffinity': selected_cpus, 'clockTicksPerSecond': os.sysconf('SC_CLK_TCK'),
        'cpuMax': read_optional('/sys/fs/cgroup/cpu.max'), 'memoryMax': read_optional('/sys/fs/cgroup/memory.max')},
    'exitCode': exit_code, 'measurementValid': exit_code == 0 and not missing_labels, 'missingCheckpoints': missing_labels, 'wallMs': (time.monotonic() - started) * 1000,
    'driverAndReapedUserSeconds': after.ru_utime - before.ru_utime,
    'driverAndReapedSystemSeconds': after.ru_stime - before.ru_stime,
    'sampledTreeCpuSeconds': sum(cpu_ticks.values()) / os.sysconf('SC_CLK_TCK'),
    'accountedTreeCpuSeconds': max(s['accountedTreeTicks'] for s in samples) / os.sysconf('SC_CLK_TCK'),
    'peakRssBytes': max((s['rssBytes'] for s in samples), default=0),
    'peakPssBytes': max((s['pssBytes'] for s in samples), default=0),
    'events': events, 'samples': samples, 'stderr': stderr,
}
output.parent.mkdir(parents=True, exist_ok=True)
# Keep sampled rows compact while retaining readable metadata and events.
header = json.dumps({k: v for k, v in report.items() if k != 'samples'}, indent=2)
output.write_text(header[:-2] + ',\n  "samples": [\n' + ',\n'.join('    ' + json.dumps(s, separators=(',', ':')) for s in samples) + '\n  ]\n}\n')
print(json.dumps({'output': str(output), 'exitCode': exit_code, 'peakRssMiB': report['peakRssBytes']/2**20, 'peakPssMiB': report['peakPssBytes']/2**20}), flush=True)
raise SystemExit(exit_code or (1 if missing_labels else 0))
