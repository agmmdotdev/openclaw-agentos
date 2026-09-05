# Memory and CPU pass

This pass adds an opt-in economy profile for the published agentOS 0.2.19
sidecar. It sets `AGENTOS_V8_WARM_ISOLATES=0` before launch, alongside the
previously tested glibc allocator settings. The guest heap stays at 256 MiB.
OpenClaw code, SQL collection, fresh shell execution and default software stay
unchanged. Each tenant retains its own sidecar pool.

The warm-isolate switch was found in the shipped binary; it is not a stable
`AgentOsOptions` field. The launcher requires the tested version and Linux/glibc,
and rejects an explicit sidecar-binary override. Revalidate the switch on an
upstream upgrade. No source or binary patch is involved.

## Results

Two 51-turn runs per agentOS mode use identical artifacts and the same compact
allocator. Controls are **37 and 42**; economy runs are **39 and 43**. Native-core
**6** runs the same 51 turns. Values below average the two agentOS run summaries;
Node is one reference run.

| Metric | Previous compact profile | Economy profile | Direct Node core |
| --- | ---: | ---: | ---: |
| Idle process-tree PSS after 51 turns | 568.1 MiB | 468.4 MiB | 324.0 MiB |
| Peak sampled PSS | 660.8 MiB | 561.6 MiB | 634.5 MiB |
| Complete lifecycle CPU | 31.09 CPU-s | 30.16 CPU-s | 3.38 CPU-s |
| CPU across 50 warm turns | 23.81 CPU-s | 23.31 CPU-s | 1.80 CPU-s |
| Launch to first result | 3.32 s | 3.26 s | 1.17 s |
| Mean of run-median warm latency | 307 ms | 320 ms | 26 ms |

This is an **18% idle-memory reduction** (about 100 MiB) and **15% lower sampled
peak memory**. Complete lifecycle CPU is about 3% lower; the roughly 2% warm-CPU
difference is too small in this sample to establish a steady-state gain. Warm
latency is slightly worse in the two economy runs. Do not describe this as a
major CPU or throughput improvement. Direct Node remains much cheaper in CPU.

Short six-turn economy trials **32, 36 and 44** measured 439–450 MiB idle and
9.09–10.07 lifecycle CPU-seconds. The previous six-turn batched controls had
520–547 MiB idle and a 10.24 CPU-second median, including the retained slow run.
The longer comparisons show that this short-workload CPU difference should not
be extrapolated to a service's steady-state savings.

Memory also grows with retained transcript history and workload activity in
both runtimes. Fifty turns are a useful repeat test, not evidence of a bounded
long-running working set. The reduction is in retained sidecar overhead; the
heap cap and eviction policy have not changed. Dispose the VM **and** its
sidecar when evicting an instance.

## Reproduce

```sh
npm run test:core:economy
# Or launch a core host using the same profile:
node scripts/run-core-economy.mjs your-core-host.mjs

# Use unused trial numbers; existing reports are protected from overwrites.
BENCH_WARM_TURNS=50 python3 scripts/benchmark/measure.py --allocator compact --trial 60
BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 61
BENCH_WARM_TURNS=50 python3 scripts/benchmark/measure.py --allocator compact --native --core --trial 60
python3 scripts/benchmark/summarize.py
```

The launcher uses Node's `process.execve` to apply allocator settings before
startup without keeping a second Node process resident. It retains the PID,
standard streams, process group, signal handling and exit status of the launched
host. The pinned Node engine range supports this API on the tested Linux host.

## Measurement scope

Each long run executes one cold and 50 warm OpenClaw turns, preserving real read
and shell tools, three inference responses per turn and transcript persistence.
Each successful run ends with 306 transcript messages. Inference is deterministic
and local; no model latency or network expense is included.

PSS covers the complete host process tree. CPU is sampled from Linux process
accounting, with PID/start-time identity to handle PID reuse. Phase CPU uses the
nearest sample to each boundary, so small differences are approximate. Phase
figures are omitted for overlapping multi-VM runs. Fifty-turn intervals are more
useful for steady-state CPU than a single turn. CPU affinity and thread counts
are now recorded. Unset runtime switches are recorded as JSON null, distinct
from an explicit string `"0"`. The unset controls in trials 37, 42 and native-core
6 were corrected from their recorded launch commands after finding that the
initial diagnostic serializer conflated these two states; the economy profile does not restrict CPU affinity.

This is a local experiment, not Cloudflare capacity or cost validation.

## Correctness and concurrent instances

`npm run test:core:economy` passes the full core gate: 132 capability assertions,
real write/read/edit/exec/apply-patch tools, eight failure/background scenarios,
continuation, VM restoration, explicit unsupported-profile checks and schema
comparisons across canonical, drift and rollback states. The report records the
actual runtime environment. TypeScript and all 11 existing unit tests pass.
The launcher was checked to retain its PID and propagate exit code 7 exactly.

Two simultaneous economy instances in **2vm-5** pass with independent SQL
bindings and sidecars. Idle total PSS is **728 MiB**, compared with **922 MiB** in
the prior batched **2vm-4** control (21% lower). Peak is 914 versus 1,103 MiB;
lifecycle CPU is 19.33 versus 19.78 CPU-seconds. Pooled warm median is 379 versus
344 ms, so this single paired comparison also shows a latency tradeoff. It
supports independent operation and memory savings, not a throughput guarantee.

## Experiments not adopted

- Trial 29: reducing the JS heap to 128 MiB did not reduce idle memory.
- Trial 30: 64 MiB JS and WASM runner heaps failed before worker readiness.
  The runtime only reported `Error: null`; this is not proof of a specific OOM.
- Trial 31: combined heap/isolate experiment, excluded from profile aggregates.
- Trial 33: two-CPU affinity did not establish a useful latency/CPU improvement.
- Trials 34–35: WASM snapshot-runner block/off settings did not establish an
  additional benefit worth depending on more internal switches.
- Trial 38: checks ran concurrently during its early portion. Retained but
  excluded from performance comparisons; trial 39 repeats without those checks.
- Trial 40: one-CPU affinity slowed warm turns; not adopted.
- Trial 41: a single 16,606,289-byte filesystem upload disconnected the sidecar.
  The original 4 MiB chunks and assembly process are retained.
- An internal positional-write API was inspected, but is not exposed on the
  public `AgentOs.filesystem` facade. No dependency patch or private access was
  added to use it.

Lower memory limits are not interchangeable with lower actual memory use.
Disabling spare isolates also does not remove the cost of executing each shell
command. The implementation preserves the real shell workload.
