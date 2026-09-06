# Correctness checks run separately from sampled performance trials.
import tempfile,os,subprocess,pathlib
os.chdir(pathlib.Path(__file__).resolve().parents[2])
with tempfile.TemporaryDirectory(prefix='openclaw-hybrid-probe-') as root:
 for name in ['workspace','state']: pathlib.Path(root,name).mkdir()
 env=dict(os.environ,BENCH_ROOT=root,OPENCLAW_STATE_DIR=root+'/state/openclaw',OPENCLAW_CHILD_OOM_SCORE_ADJ='0',AGENTOS_V8_WARM_ISOLATES='0',MALLOC_ARENA_MAX='1',MALLOC_TRIM_THRESHOLD_='65536',MALLOC_MMAP_THRESHOLD_='65536')
 p=subprocess.run(['node','artifacts/core/hybrid-probe.mjs','--internal-worker-prewarm'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 print(p.stdout);print(p.stderr[-3500:]);raise SystemExit(p.returncode)
