#!/usr/bin/env python3
import argparse, json, statistics, os
from pathlib import Path
root = Path(__file__).resolve().parents[2]
folder = root / 'artifacts/results'
parser = argparse.ArgumentParser()
parser.add_argument('--trials', nargs='+', type=int, help='Include only these trial numbers')
parser.add_argument('--output', default='benchmark-summary.json', help='Output filename inside artifacts/results')
args = parser.parse_args()
if Path(args.output).name != args.output: parser.error('--output must be a filename')
rows = []
for path in sorted(folder.glob('benchmark-*.json')):
    if path.name in ('benchmark-summary.json', 'benchmark-bottlenecks.json'): continue
    report = json.loads(path.read_text())
    if args.trials and report.get('trial') not in args.trials: continue
    events, samples = report['events'], report['samples']
    def event(label, instance=None):
        return next((e for e in events if e['label'] == label and (instance is None or e.get('instance') == instance)), None)
    def median_memory(start, end):
        values = [s['pssBytes'] / 2**20 for s in samples if start <= s['atMs'] < end and s['pssBytes'] > 0]
        return statistics.median(values) if values else None
    def checkpoint_memory(label):
        index = next((i for i,e in enumerate(events) if e['label'] == label), None)
        return median_memory(events[index]['receivedAtMs'], events[index+1]['receivedAtMs']) if index is not None and index+1<len(events) else None
    idle_starts = [e['receivedAtMs'] for e in events if e['label'] == 'idle:start']
    idle_ends = [e['receivedAtMs'] for e in events if e['label'] == 'idle:end']
    clock_offset = min((e['receivedAtMs'] - e['atMs'] for e in events), default=0)
    ticks = {}
    inclusive = all('accountedTreeTicks' in s for s in samples)
    high = 0
    cumulative_cpu = []
    clock_ticks = report.get('environment', {}).get('clockTicksPerSecond', os.sysconf('SC_CLK_TCK'))
    for sample in samples:
        for process in sample['processes']:
            key=(process['pid'], process['startTicks'])
            ticks[key]=max(ticks.get(key,0),process['ticks'])
        high = max(high, sample.get('accountedTreeTicks', sum(ticks.values())))
        cumulative_cpu.append((sample['atMs'], high / clock_ticks))
    def cpu_at(at_ms):
        return min(cumulative_cpu, key=lambda item: abs(item[0] - at_ms))[1] if cumulative_cpu else 0
    def phase_cpu(start, end):
        if report['instances'] != 1: return None  # overlapping multi-VM intervals are not additive
        begin, finish = event(start), event(end)
        return max(0, cpu_at(finish['atMs'] + clock_offset) - cpu_at(begin['atMs'] + clock_offset)) if begin and finish else None
    native = 'native' in path.name
    instances=[]
    for index in range(report['instances']):
        cold_start=event('cold-turn:start',index); cold_end=event('cold-turn:end',index)
        if not cold_end: continue
        launch=event('launch:start')
        ready=event('worker-ready',index)
        instance={'index':index,'coldTurnMs':cold_end['durationMs'],
            'launchToFirstResultMs':cold_end['atMs']-launch['atMs'] if launch else cold_end['receivedAtMs'],
            'launchToReadyMs':ready['atMs']-launch['atMs'] if launch else ready['receivedAtMs'],
            'warmTurnMs':[e['durationMs'] for e in events if e.get('instance')==index and e['label'].startswith('warm-turn-') and e['label'].endswith(':end')]}
        if cold_start and 'sqliteCalls' in cold_start:
            instance['coldSqliteCalls']=cold_end['sqliteCalls']-cold_start['sqliteCalls']
            instance['coldHostSqlMs']=cold_end['hostSqlMilliseconds']-cold_start['hostSqlMilliseconds']
            if 'guestSql' in cold_start: instance['coldGuestSqlMs']=cold_end['guestSql']['milliseconds']-cold_start['guestSql']['milliseconds']
        instances.append(instance)
    warm_ends = [e for e in events if e['label'].startswith('warm-turn-') and e['label'].endswith(':end')]
    last_warm = warm_ends[-1]['label'] if warm_ends else 'warm-turn-5:end'
    rows.append({'file':path.name,'runtime':report.get('runtime','native' if native else 'agentos'),
        'nodeSemiSpaceMiB':report.get('nodeSemiSpaceMiB'), 'nodeMaxOpt':report.get('nodeMaxOpt'),
        'sqlStatementCacheSize':report.get('sqlStatementCacheSize',0),
        'dataMount':report.get('dataMount','chunked_local'),
        'idleMs':report.get('idleMs',1500),
        'representativeConfig':event('representative:config'),
        'representativeResult':event('representative:complete'),
        'wasmer':report.get('wasmer'),
        'activeMedianPssMiB':median_memory(event('cold-turn:start')['receivedAtMs'],event(last_warm)['receivedAtMs']) if event('cold-turn:start') and event(last_warm) else None,
        'workload':report.get('diagnostics',{}).get('BENCH_WORKLOAD') or 'core-shell',
        'profile':report.get('coreManifest',{}).get('profile','full'),
        'coreArtifactMode': next((e.get('coreMount', 'upload') for e in events if e['label'] == 'baseline'), 'native'),
        'canonicalTableBatching': (event('baseline') or {}).get('canonicalBatching', not native and 'collectCanonicalStrictTableMetadata' in report.get('coreManifest', {}).get('schemaCollector', {}).get('roots', []) and report.get('diagnostics', {}).get('BENCH_SQL_SCHEMA_MODE') not in ('individual', 'table-only', 'table-index')),
        'namedIndexBatching': not native and 'collectSqliteNamedIndexContract' in report.get('coreManifest', {}).get('schemaCollector', {}).get('roots', []) and report.get('diagnostics', {}).get('BENCH_SQL_SCHEMA_MODE') not in ('individual', 'table-only'),
        'schemaExecution':'native' if native else 'host-batched' if report.get('coreManifest',{}).get('schemaCollector') and report.get('diagnostics',{}).get('BENCH_SQL_SCHEMA_MODE') != 'individual' else 'guest-individual',
        'allocatorEnvironment':report.get('allocatorEnvironment',{}),
        'diagnostics':report.get('diagnostics',{}),
        'experimentNotes':report.get('experimentNotes',[]),
        'configuredInstances':report['instances'],'passed':report['exitCode']==0 and report.get('measurementValid', True),
        'placement':event('baseline').get('placement','shared-default') if event('baseline') else 'native-process',
        'splitInitializer':report.get('splitInitializer',False),'instances':instances,
        'sampledTreeCpuSeconds':sum(ticks.values())/clock_ticks,
        'accountedTreeCpuSeconds':report.get('accountedTreeCpuSeconds'),
        'phaseCpuIncludesReapedChildren':inclusive,
        'cpuAffinity':report.get('environment',{}).get('cpuAffinity'),
        'phaseCpuSeconds':{
            'provision':phase_cpu('provision:start','empty-vms'),
            'stage':phase_cpu('stage:start','staged'),
            'cold':phase_cpu('cold-turn:start','cold-turn:end'),
            'warmFive':phase_cpu('warm-turn-1:start','warm-turn-5:end'),
            'warmAll':phase_cpu('warm-turn-1:start',last_warm),
            'idle':phase_cpu('idle:start','idle:end'),
        },
        'peakPssMiB':report['peakPssBytes']/2**20,'peakRssMiB':report['peakRssBytes']/2**20,
        'allIdlePssMiB':median_memory(max(idle_starts),min(idle_ends)) if idle_starts and idle_ends and max(idle_starts)<min(idle_ends) else None,
        'earlyIdlePssMiB':median_memory(max(idle_starts),min(min(idle_ends),max(idle_starts)+1500)) if idle_starts and idle_ends else None,
        'lateIdlePssMiB':median_memory(max(max(idle_starts),min(idle_ends)-5000),min(idle_ends)) if idle_starts and idle_ends else None,
        'baselinePssMiB':checkpoint_memory('baseline'),'emptyVmsPssMiB':checkpoint_memory('empty-vms'),
        'stagedPssMiB':checkpoint_memory('staged'),'disposedVmsPssMiB':checkpoint_memory('disposed-host-gc'),
        'disposedSidecarsPssMiB':checkpoint_memory('sidecars-disposed')})
result={'method':{'memory':'MiB; sampled process-tree PSS includes Node, its worker threads, and native sidecars/children where present; RSS also retained',
    'cpu':'Sum of maximum sampled CPU ticks per PID/start-time identity; phases align event clocks, include reaped children where indicated, and use nearest 100 ms samples and are emitted only for one VM. Approximate, may miss CPU between the last sample and exit',
    'latency':'See each run workload and representativeConfig: identical fixtures within a comparison, synthetic inference; BENCH_WARM_TURNS selects repeat count; cold means fresh process/storage with warm host file cache',
    'scope':'Small local experiment, not production capacity or cloud billing'},'runs':rows}
(folder/args.output).write_text(json.dumps(result,indent=2)+'\n')
for row in rows:
    warm=[v for instance in row['instances'] for v in instance['warmTurnMs']]
    print(row['file'], 'PASS' if row['passed'] else 'FAIL',
          'launch->first:', [round(i['launchToFirstResultMs']) for i in row['instances']],
          'warm median:',round(statistics.median(warm),1) if warm else None,
          'idle MiB:',round(row['allIdlePssMiB'],1) if row['allIdlePssMiB'] else None,
          'peak MiB:',round(row['peakPssMiB'],1))
