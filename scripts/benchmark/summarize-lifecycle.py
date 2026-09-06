#!/usr/bin/env python3
import hashlib,json,statistics
from pathlib import Path
root=Path(__file__).resolve().parents[2]
results=root/'artifacts/results'
groups=[];sources=[];outliers=[]
configs=[(b,m,range(1610,1613)) for b in ['direct','sdk'] for m in ['resident','request','request-cache']]+[('sdk-upstream',m,range(1621,1624)) for m in ['resident','request-cache']]
for backend,mode,trials in configs:
 reports=[]
 for trial in trials:
  file=results/f'lifecycle-{backend}-{mode}-{trial}.json';r=json.loads(file.read_text())
  assert r['valid'],file
  reports.append(r);sources.append({'path':str(file.relative_to(root)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
  for run in r['runs']:
   samples=run['samples'];gap=max((b['atMs']-a['atMs'] for a,b in zip(samples,samples[1:])),default=0)
   ready=next(e['receivedAtMs'] for e in run['events'] if e['label']=='worker-ready')
   if gap>1000 or ready>5000:outliers.append({'file':file.name,'process':run['index'],'wallMs':run['wallMs'],'cpuSeconds':run['cpuSeconds'],'workerReadyMs':ready,'maxSamplingGapMs':gap,'note':'Retained in trial medians/ranges; sampled peak is less reliable during long gaps; cause not isolated'})
 keys=['warmTurnMedianMs','totalCpuSeconds','peakPssMiB','idleCorePssMiB','subsequentProcessMedianMs','subsequentCpuMedianSeconds']
 row={'backend':backend,'mode':mode,'trials':list(trials),'turnsPerTrial':7}
 for key in keys:
  vals=[r['summary'][key] for r in reports if r['summary'][key] is not None]
  row[key]=statistics.median(vals) if vals else None
 row['cpuSecondsRange']=[min(r['summary']['totalCpuSeconds'] for r in reports),max(r['summary']['totalCpuSeconds'] for r in reports)]
 row['peakPssMiBRange']=[min(r['summary']['peakPssMiB'] for r in reports),max(r['summary']['peakPssMiB'] for r in reports)]
 row['firstRequestMedianMs']=statistics.median(r['runs'][0]['wallMs'] for r in reports) if mode!='resident' else None
 groups.append(row)
extra=[]
for name in ['lifecycle-sdk-request-1624.json','lifecycle-sdk-request-cache-1630.json','lifecycle-sdk-request-cache-1641.json']:
 file=results/name
 if file.exists():
  r=json.loads(file.read_text());assert r['valid'];extra.append({'path':str(file.relative_to(root)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'summary':r['summary'],'validation':r['validation']})
report={'method':'Median of three per-trial statistics, seven turns and 35 tool calls each; original 18 runs plus six original-supervisor controls. Extra followups are not substituted for the original trials. No gateway, real model or protected execution. Resident warm-turn time excludes startup; request process time includes startup/checkpoint/exit.','groups':groups,'outliers':outliers,'sources':sources,'extraValidation':extra}
(results/'request-lifecycle-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print('| Backend / mode | Idle core PSS MiB | Warm turn ms | Subsequent process ms | CPU / 7 turns s | Peak PSS range MiB |')
print('|---|---:|---:|---:|---:|---:|')
for r in groups:
 proc='—' if r['subsequentProcessMedianMs'] is None else f"{r['subsequentProcessMedianMs']:.0f}"
 print(f"| {r['backend']} / {r['mode']} | {r['idleCorePssMiB']:.1f} | {r['warmTurnMedianMs']:.0f} | {proc} | {r['totalCpuSeconds']:.2f} | {r['peakPssMiBRange'][0]:.0f}–{r['peakPssMiBRange'][1]:.0f} |")
print(json.dumps({'outliers':outliers,'extraValidation':extra}))
