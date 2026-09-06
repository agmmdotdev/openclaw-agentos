# Correctness checks run separately from sampled performance trials.
import tempfile,os,subprocess,pathlib,argparse
parser=argparse.ArgumentParser()
parser.add_argument("--node-memory-profile", action="store_true")
parser.add_argument("--wasmer", action="store_true")
parser.add_argument("--native-sdk", action="store_true")
parser.add_argument("--request-profile", action="store_true")
args=parser.parse_args()
if args.request_profile and (not args.native_sdk or args.node_memory_profile): parser.error("Request profile requires native SDK without another memory profile")
os.chdir(pathlib.Path(__file__).resolve().parents[2])
with tempfile.TemporaryDirectory(prefix='openclaw-hybrid-probe-') as root:
 for name in ['workspace','state']: pathlib.Path(root,name).mkdir()
 env=dict(os.environ,BENCH_ROOT=root,OPENCLAW_STATE_DIR=root+'/state/openclaw',OPENCLAW_CHILD_OOM_SCORE_ADJ='0',AGENTOS_V8_WARM_ISOLATES='0',MALLOC_ARENA_MAX='1',MALLOC_TRIM_THRESHOLD_='65536',MALLOC_MMAP_THRESHOLD_='65536')
 command=['node'] + (['scripts/run-core-node-request.mjs'] if args.request_profile else ['scripts/run-core-node-memory.mjs'] if args.node_memory_profile else []) + (['--experimental-wasm-jspi'] if args.wasmer else []) + ['artifacts/core/native-sdk-probe.mjs' if args.native_sdk else 'artifacts/core/wasmer-probe.mjs' if args.wasmer else 'artifacts/core/hybrid-probe.mjs','--internal-worker-prewarm']
 p=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 print(p.stdout);print(p.stderr[-3500:]);raise SystemExit(p.returncode)
