#!/usr/bin/env python3
import json, statistics, os
from pathlib import Path
root = Path(__file__).resolve().parents[2]
folder = root / 'artifacts/results'
rows = []
for path in sorted(folder.glob('benchmark-*.json')):
    if path.name == 'benchmark-summary.json': continue
    report = json.loads(path.read_text())
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
    ticks = {}
    for sample in samples:
        for process in sample['processes']:
            key=(process['pid'], process['startTicks'])
            ticks[key]=max(ticks.get(key,0),process['ticks'])
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
    rows.append({'file':path.name,'runtime':report.get('runtime','native' if native else 'agentos'),
        'configuredInstances':report['instances'],'passed':report['exitCode']==0,
        'placement':event('baseline').get('placement','shared-default') if event('baseline') else 'native-process',
        'splitInitializer':report.get('splitInitializer',False),'instances':instances,
        'sampledTreeCpuSeconds':sum(ticks.values())/os.sysconf('SC_CLK_TCK'),
        'peakPssMiB':report['peakPssBytes']/2**20,'peakRssMiB':report['peakRssBytes']/2**20,
        'allIdlePssMiB':median_memory(max(idle_starts),min(idle_ends)) if idle_starts and idle_ends and max(idle_starts)<min(idle_ends) else None,
        'baselinePssMiB':checkpoint_memory('baseline'),'emptyVmsPssMiB':checkpoint_memory('empty-vms'),
        'stagedPssMiB':checkpoint_memory('staged'),'disposedVmsPssMiB':checkpoint_memory('disposed-host-gc'),
        'disposedSidecarsPssMiB':checkpoint_memory('sidecars-disposed')})
result={'method':{'memory':'MiB; sampled process-tree PSS includes Node driver and native sidecars; RSS also retained',
    'cpu':'Sum of maximum sampled CPU ticks per PID/start-time identity; approximate, may miss the final sample before exit',
    'latency':'Same read + shell exec turn, synthetic inference, six turns per guest; cold means fresh process/storage with warm host file cache',
    'scope':'Small local experiment, not production capacity or cloud billing'},'runs':rows}
(folder/'benchmark-summary.json').write_text(json.dumps(result,indent=2)+'\n')
for row in rows:
    warm=[v for instance in row['instances'] for v in instance['warmTurnMs']]
    print(row['file'], 'PASS' if row['passed'] else 'FAIL',
          'launch->first:', [round(i['launchToFirstResultMs']) for i in row['instances']],
          'warm median:',round(statistics.median(warm),1) if warm else None,
          'idle MiB:',round(row['allIdlePssMiB'],1) if row['allIdlePssMiB'] else None,
          'peak MiB:',round(row['peakPssMiB'],1))
