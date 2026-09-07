#!/usr/bin/env python3
"""Serial representative turns: persistent core vs fresh process per request.
Trusted workloads only. Control/sampler memory is excluded in every mode.
"""
import argparse, ctypes, hashlib, json, os, platform, resource, selectors, signal, statistics, subprocess, tempfile, time
from pathlib import Path
from process_metrics import proc_info, sample

parser=argparse.ArgumentParser()
parser.add_argument('--backend',choices=['direct','sdk','sdk-upstream'],required=True)
parser.add_argument('--mode',choices=['resident','request','request-cache'],required=True)
parser.add_argument('--turns',type=int,default=7)
parser.add_argument('--trial',type=int,required=True)
parser.add_argument('--interval',type=float,default=.04)
parser.add_argument('--initialization',choices=['current','eager','bundled','before-allocations'],default='current',help='Use current core or a matched SDK initialization control')
parser.add_argument('--profile',choices=['default','request'],default='default')
parser.add_argument('--request-launcher',choices=['single','execve'],default='single',help='Single Node startup or legacy Node execve launcher; request profile only')
parser.add_argument('--startup-diagnostics',choices=['phases','cpu','allocations'],help='Instrument startup phases; cpu/allocations also record V8 profiles. Diagnostic timings are not performance comparisons.')
parser.add_argument('--max-opt',type=int,choices=[0,1,2,3])
parser.add_argument('--wasm-tiering',choices=['on','off','liftoff-only','no-loop-unrolling','no-loop-transforms'],default='on',help='Native core V8 WebAssembly optimizing tier; does not change spawned Node tools')
args=parser.parse_args()
if args.initialization!='current' and args.backend!='sdk': parser.error('Initialization controls require SDK backend')
if args.startup_diagnostics and (args.backend!='sdk' or args.initialization=='eager' or args.mode=='resident'): parser.error('Startup diagnostics require SDK request mode and current/bundled initialization')
if args.profile=='request' and (args.max_opt is not None or args.wasm_tiering!='on'): parser.error('Request profile cannot be combined with diagnostic compiler overrides')
if args.profile!='request' and args.request_launcher!='single': parser.error('Launcher controls require request profile')
if not 2<=args.turns<=101 or args.interval<=0: parser.error('Invalid turns/interval')
if os.environ.get('AGENTOS_LINUX_EXPERIMENT')=='1': parser.error('Protected performance is not validated')
ROOT=Path(__file__).resolve().parents[2]
output=ROOT/f'artifacts/results/lifecycle-{args.backend}-{args.mode}-{args.trial}.json'
if output.exists() or output.with_suffix('.json.gz').exists(): parser.error('Result already exists')
# Adopt only our trusted descendants so cleanup failures are observable after
# the root exits. This is measurement infrastructure, not a workload sandbox.
if ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0: raise RuntimeError('Cannot become test subreaper')
parent=int(os.readlink('/proc/self'))
cpus=sorted(os.sched_getaffinity(0))[:2]
entry=f'artifacts/core/{args.initialization}-native-sdk-core-benchmark.mjs' if args.initialization!='current' else 'artifacts/core/native-sdk-supervised-benchmark.mjs' if args.backend=='sdk-upstream' else 'artifacts/core/native-sdk-core-benchmark.mjs' if args.backend=='sdk' else 'artifacts/core/native-core-benchmark.mjs'
source_entry=entry
profile_dir=ROOT/f'artifacts/results/startup-tail-{args.trial}'
if args.startup_diagnostics:
    entry=f'artifacts/core/startup-tail-{args.trial}.mjs'
    subprocess.run(['node','scripts/diagnostics/build-startup-entry.mjs',source_entry,entry],cwd=ROOT,check=True)
    profile_dir.mkdir()

def mounted_pid(child):
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if proc_info(int(p.name))['ppid']!=parent: continue
            ns=next(l for l in (p/'status').read_text().splitlines() if l.startswith('NSpid:'))
            if int(ns.split()[-1])==child.pid: return int(p.name)
        except (OSError,ValueError,StopIteration): pass
    raise RuntimeError('Cannot resolve mounted process PID')

def direct_children():
    found=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            info=proc_info(int(p.name))
            if info['ppid']==parent: found.append(info)
        except (OSError,ValueError): pass
    return found

def run(env,index):
    before=resource.getrusage(resource.RUSAGE_CHILDREN)
    start=time.monotonic();events=[];startup_events=[];samples=[];logs=[];buffers={};seen={}
    command=(['sh','scripts/run-core-node-request.sh'] if args.request_launcher=='single' else ['node','scripts/run-core-node-request.mjs']) if args.profile=='request' else ['node','--max-semi-space-size=8']+([f'--max-opt={args.max_opt}'] if args.max_opt is not None else [])+({'on':[],'off':['--no-wasm-tier-up'],'liftoff-only':['--liftoff-only'],'no-loop-unrolling':['--no-wasm-loop-unrolling'],'no-loop-transforms':['--no-wasm-loop-unrolling','--no-wasm-loop-peeling']}[args.wasm_tiering])
    if args.startup_diagnostics:
        command+=['--import',str(ROOT/('scripts/diagnostics/allocation-preload.mjs' if args.startup_diagnostics=='allocations' else 'scripts/diagnostics/startup-preload.mjs'))]
        if args.startup_diagnostics=='allocations': env={**env,'STARTUP_ALLOCATION_OUTPUT':str(profile_dir/f'request-{index}.heapprofile.json.gz')}
        if args.startup_diagnostics=='cpu': command+=['--cpu-prof','--cpu-prof-interval=1000',f'--cpu-prof-dir={profile_dir}',f'--cpu-prof-name=request-{index}.cpuprofile']
    child=subprocess.Popen(command+[entry,'--internal-worker-prewarm'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=lambda:os.sched_setaffinity(0,cpus))
    pid=mounted_pid(child);selector=selectors.DefaultSelector()
    for stream in [child.stdout,child.stderr]:
        os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ);buffers[stream.fileno()]=b''
    next_sample=start
    try:
        while selector.get_map() or child.poll() is None:
            now=time.monotonic()
            if now-start>120: raise TimeoutError('Core did not drain/exit within 120s')
            if now>=next_sample:
                row=sample(pid);row['atMs']=(now-start)*1000;samples.append(row)
                for p in row['processes']: seen[(p['pid'],p['startTicks'])]=p
                next_sample=now+args.interval
            for key,_ in selector.select(max(0,min(.04,next_sample-time.monotonic()))):
                data=os.read(key.fd,65536)
                if not data: selector.unregister(key.fileobj);continue
                buffers[key.fd]+=data
                while b'\n' in buffers[key.fd]:
                    line,buffers[key.fd]=buffers[key.fd].split(b'\n',1);line=line.decode(errors='replace')
                    if line.startswith('BENCH_EVENT='):
                        event=json.loads(line[12:]);event['receivedAtMs']=(time.monotonic()-start)*1000;events.append(event)
                    elif line.startswith('STARTUP_EVENT='):
                        event=json.loads(line[14:]);event['receivedAtMs']=(time.monotonic()-start)*1000;startup_events.append(event)
                    else: logs.append(line)
        code=child.wait()
    finally:
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGKILL);child.wait()
        selector.close();child.stdout.close();child.stderr.close()
    # Reap adopted exited descendants; surviving children are a failed result.
    while True:
        try:
            reaped,_=os.waitpid(-1,os.WNOHANG)
            if not reaped: break
        except ChildProcessError: break
    survivors=direct_children()
    after=resource.getrusage(resource.RUSAGE_CHILDREN)
    checkpoints=[e for e in events if e['label']=='representative:complete']
    expected=args.turns if args.mode=='resident' else 1
    valid=code==0 and len(checkpoints)==1 and checkpoints[0]['turns']==expected and checkpoints[0]['toolCounts']=={'read':expected,'exec':expected*2,'edit':expected,'write':expected} and not survivors
    valid=valid and any(e['label']==('idle:end' if args.mode=='resident' else 'request:complete') for e in events)
    if not any(s['pssBytes']>0 for s in samples): valid=False
    result={'index':index,'exitCode':code,'valid':valid,'wallMs':(time.monotonic()-start)*1000,'cpuSeconds':after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime,'peakPssMiB':max((s['pssBytes'] for s in samples),default=0)/2**20,'peakRssMiB':max((s['rssBytes'] for s in samples),default=0)/2**20,'survivingChildren':survivors,'events':events,'logs':logs,'samples':samples}
    if args.startup_diagnostics:
        expected=['preload','core-evaluation:start','core-evaluation:end','sdk-import:start','sdk-import:end','sdk-create:start','sdk-create:end','embedded-init:start','embedded-init:end','checkpoint:start','checkpoint:end','worker-ready','before-exit']
        result['startupEvents']=startup_events
        result['valid'] &= [event['phase'] for event in startup_events]==expected
        if args.startup_diagnostics=='cpu':
            path=profile_dir/f'request-{index}.cpuprofile'
            result['cpuProfile']=str(path.relative_to(ROOT))
            result['valid'] &= path.is_file()
        if args.startup_diagnostics=='allocations':
            path=profile_dir/f'request-{index}.heapprofile.json.gz'
            result['allocationProfile']=str(path.relative_to(ROOT))
            result['valid'] &= path.is_file()
    return result

runs=[];validation={};started=time.monotonic()
with tempfile.TemporaryDirectory(prefix='core-lifecycle-') as directory:
    base=Path(directory)
    for d in ['workspace','state','compile-cache']: (base/d).mkdir()
    env=os.environ.copy()
    for key in ['NODE_OPTIONS','NODE_COMPILE_CACHE','NODE_DISABLE_COMPILE_CACHE','AGENTOS_LINUX_EXPERIMENT','BENCH_REQUEST_TURN','BENCH_NATIVE_MEMORY','BENCH_GC_AT_IDLE','BENCH_PROFILE_CORE','BENCH_SPLIT_INIT']: env.pop(key,None)
    env.update(BENCH_ROOT=directory,BENCH_WORKLOAD='core-workload',BENCH_WARM_TURNS=str(args.turns-1),BENCH_IDLE_MS='1500',OPENCLAW_STATE_DIR=str(base/'state/openclaw'),OPENCLAW_CHILD_OOM_SCORE_ADJ='0',AGENTOS_SDK_FILESYSTEM='node',MALLOC_ARENA_MAX='1',MALLOC_TRIM_THRESHOLD_='65536',MALLOC_MMAP_THRESHOLD_='65536')
    if args.mode=='request-cache': env['NODE_COMPILE_CACHE']=str(base/'compile-cache')
    for turn in range(1 if args.mode=='resident' else args.turns):
        if args.mode!='resident': env['BENCH_REQUEST_TURN']=str(turn)
        result=run(env,turn);runs.append(result)
        print(json.dumps({k:result[k] for k in ['index','valid','wallMs','cpuSeconds','peakPssMiB']}),flush=True)
        if not result['valid']:
            output.write_text(json.dumps({'valid':False,'backend':args.backend,'mode':args.mode,'runs':runs},indent=2)+'\n')
            print(json.dumps({'logs':result['logs'],'events':result['events']}),flush=True)
            raise SystemExit(1)
        if args.mode!='resident':
            saved=json.loads((base/'state/request-checkpoint.json').read_text())
            if saved['nextTurn']!=turn+1 or len(saved['messages'])!=24+(turn+1)*12: raise RuntimeError('Persisted checkpoint continuity failed')
            if (base/'state/request-inflight.json').exists(): raise RuntimeError('Committed request still pending')
            # The OS has reaped all workload processes; idle core memory is zero.
            time.sleep(.1)
    config=(base/'workspace/config.txt').read_text()
    history=json.loads((base/'state/transcript.json').read_text()) if args.mode=='resident' else json.loads((base/'state/request-checkpoint.json').read_text())['messages']
    reports=sorted((base/'workspace/reports').glob('turn-*.md'))
    events=(base/'state/events.jsonl').read_text().splitlines()
    validation={'configVersion':config.splitlines()[0],'messages':len(history),'reports':len(reports),'transcriptEvents':len(events),'cacheFiles':len([p for p in (base/'compile-cache').rglob('*') if p.is_file()]),'pendingRequest':(base/'state/request-inflight.json').exists()}
    validation['passed']=config.startswith(f'version={args.turns}\n') and len(history)==24+args.turns*12 and len(reports)==args.turns and len(events)==args.turns*12 and not validation['pendingRequest']

all_samples=[s for r in runs for s in r['samples']]
idle=[]
if args.mode=='resident':
    start=next(e['receivedAtMs'] for e in runs[0]['events'] if e['label']=='idle:start')
    idle=[s['pssBytes']/2**20 for s in runs[0]['samples'] if s['atMs']>=start and s['pssBytes']>0]
turn_events=[e for r in runs for e in r['events'] if e['label'].endswith('turn:end') or (e['label'].startswith('warm-turn-') and e['label'].endswith(':end'))]
warm_events=[e for e in turn_events if e['label'].startswith('warm-turn-')]
summary={'warmTurnMedianMs':statistics.median(e['durationMs'] for e in warm_events) if warm_events else None,'totalCpuSeconds':sum(r['cpuSeconds'] for r in runs),'totalProcessWallMs':sum(r['wallMs'] for r in runs),'peakPssMiB':max(r['peakPssMiB'] for r in runs),'idleCorePssMiB':statistics.median(idle) if idle else 0 if args.mode!='resident' else None,'firstProcessMs':runs[0]['wallMs'],'subsequentProcessMedianMs':statistics.median(r['wallMs'] for r in runs[1:]) if len(runs)>1 else None,'subsequentCpuMedianSeconds':statistics.median(r['cpuSeconds'] for r in runs[1:]) if len(runs)>1 else None}
report={'valid':all(r['valid'] for r in runs) and validation['passed'],'backend':args.backend,'mode':args.mode,'turns':args.turns,'trial':args.trial,'sampleIntervalMs':args.interval*1000,'environment':{'node':subprocess.check_output(['node','--version'],text=True).strip(),'platform':platform.platform(),'cpus':cpus,'semiSpaceMiB':8,'profile':args.profile,'initialization':args.initialization,'wasmTiering':'liftoff-only' if args.profile=='request' else args.wasm_tiering,'maxOpt':args.max_opt,'allocator':{'MALLOC_ARENA_MAX':'1','MALLOC_TRIM_THRESHOLD_':'65536','MALLOC_MMAP_THRESHOLD_':'65536'}},'method':'Trusted native process tree PSS; external Python sampler excluded; 420ms scripted inference per turn; cache begins empty per trial; normal process exit (no forced exit); subreaper checks only trusted descendants; direct OpenClaw supervisor vs SDK supervisor still differ','summary':summary,'validation':validation,'benchmarkManifest':json.loads((ROOT/'artifacts/core/benchmark-manifest.json').read_text()),'entrySha256':hashlib.sha256((ROOT/entry).read_bytes()).hexdigest(),'requestLauncherSha256':hashlib.sha256((ROOT/'scripts/run-core-node-request.mjs').read_bytes()).hexdigest(),'harnessSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'samplerSha256':hashlib.sha256((ROOT/'scripts/benchmark/process_metrics.py').read_bytes()).hexdigest(),'runs':runs}
if args.startup_diagnostics=='allocations':
    report['allocationPreloadSha256']=hashlib.sha256((ROOT/'scripts/diagnostics/allocation-preload.mjs').read_bytes()).hexdigest()
if args.startup_diagnostics:
    report['startupDiagnostics']={'mode':args.startup_diagnostics,'sourceEntry':source_entry,'sourceEntrySha256':hashlib.sha256((ROOT/source_entry).read_bytes()).hexdigest(),'preloadSha256':hashlib.sha256((ROOT/'scripts/diagnostics/startup-preload.mjs').read_bytes()).hexdigest(),'builderSha256':hashlib.sha256((ROOT/'scripts/diagnostics/build-startup-entry.mjs').read_bytes()).hexdigest(),'note':'Phase markers and optional V8 CPU profiling perturb execution. Do not combine with uninstrumented performance comparisons.'}
report['environment']['requestLauncher']=args.request_launcher if args.profile=='request' else None
if args.profile=='request' and args.request_launcher=='single': report['requestLauncherSha256']=hashlib.sha256((ROOT/'scripts/run-core-node-request.sh').read_bytes()).hexdigest()
report['singleStartupLauncher']={'shellSha256':hashlib.sha256((ROOT/'scripts/run-core-node-request.sh').read_bytes()).hexdigest(),'guardSha256':hashlib.sha256((ROOT/'scripts/core/request-profile-guard.mjs').read_bytes()).hexdigest()} if args.profile=='request' and args.request_launcher=='single' else None
output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'output':str(output),'valid':report['valid'],'summary':summary}),flush=True)
raise SystemExit(0 if report['valid'] else 1)
