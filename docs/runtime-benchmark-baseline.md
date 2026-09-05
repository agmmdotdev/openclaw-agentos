# OpenClaw / agentOS runtime measurements

The current adapter makes the core flow execute, but it has **not achieved the
lightweight, inexpensive runtime goal**. This workload runs faster and uses less
idle memory directly on Node. Both approaches pay a substantial loading cost
for the large standalone worker.

## Results

Same OpenClaw 2026.8.1 core, one `read` and one shell `exec` per turn, three
inference calls, real transcript commits, and five subsequent warm turns.
Inference is deterministic and makes no network requests.

Memory below is measured **process-tree PSS**, in MiB (1 MiB = 1,048,576 bytes).
It includes the Node host and all native agentOS sidecar processes. It is not
the configured guest heap limit. RSS and every sample are also retained.

| Configuration | Launch to first completed turn | Warm turn | Idle PSS | Peak PSS |
| --- | ---: | ---: | ---: | ---: |
| Native Node, published worker; 2 runs | 2.07–2.14 s | Run medians 30–36 ms | 572 MiB | 979–986 MiB |
| Native Node, lowered worker with native builtins; 1 run | 2.26 s | Median 41 ms | 666 MiB | 1,048 MiB |
| agentOS, one instance; 5 runs | 19.88–26.29 s | Run medians 321–387 ms | 1,040–1,130 MiB | 1,125–1,221 MiB |
| agentOS, two concurrent instances, separate sidecars; 1 run | 21.67–21.73 s per instance | Pooled median 434 ms | 1,944 MiB total | 2,117 MiB total |

Launch timing excludes compilation, VM provisioning and artifact transfer. The
benchmark builds before starting the measured process. For native Node, launch
starts at OS process creation; for agentOS, it starts when the host submits the
already-staged guest entry. Native timing therefore includes a little more host
startup work. The direct Node baseline preserves the real core but uses native
SQLite and builtins. It is a comparison of the complete configurations, not an
isolated JavaScript engine benchmark.

AgentOS trial 3 was slower and larger than the other single-instance trials; it
is retained in the range. Do not interpret a five-run sample as a stable p95.
The lowered Node control shows that async lowering alone does not explain the
large latency gap. That control restores native builtin imports; it keeps the
three native async-iterator intrinsic references needed by lowered code.

## Where time and memory go

A representative instrumented single-instance run (`benchmark-1vm-4.json`):

| Checkpoint / operation | Measurement |
| --- | ---: |
| SDK-loaded host baseline, before a VM | 66.5 MiB PSS |
| Provisioned empty VM, including mounts and setup | 238.1 MiB PSS |
| Code and parser assets staged | 395.0 MiB PSS |
| Idle after six successful core turns | 1,043.4 MiB PSS |
| After VM disposal and outer Node GC | 756.3 MiB PSS |
| After explicit sidecar disposal | 89.0 MiB PSS |
| Cold core turn after worker-ready checkpoint | 17.83 s |
| SQLite binding calls during that turn | 3,283 |
| Time inside guest SQLite adapter calls | 2.08 s |
| Time inside host SQLite binding handler | 0.20 s |

The SQL call count initially suggested transport was the main bottleneck. Direct
timing disproves that: guest SQLite calls account for about **12%** of the cold
turn, including encoding, transport, host work and decoding. A separate 50-query
`SELECT 1` calibration takes 24–31 ms in the guest adapter, versus roughly a
tenth of a millisecond with native Node SQLite. Transport is expensive relative
to native SQLite, but eliminating it alone cannot remove the remaining cold
startup time.

Calling `init_embedded_agent_runtime()` separately in trial 5 took less than the
guest clock's 1 ms resolution and did not remove the slow first turn. The large
cost is in first-turn runtime work after loading, not simply that lazy module
initializer. A guest CPU/call profile is still needed to identify the remaining
hot paths. Do not attribute those unmeasured paths to SQLite or the compiler.

The representative single-instance process tree accumulated about 32 sampled
CPU-seconds across the complete lifecycle; the two-instance run about 63.
These include loading, six turns, calibration and disposal, and CPU across
multiple native threads. They are approximate sampled totals, not billable CPU.
Python `RUSAGE_CHILDREN` alone missed the persistent sidecar, so totals are
computed from each observed PID's CPU ticks. Earlier raw reports retain their
narrower rusage fields; `benchmark-summary.json` uses the corrected calculation.

The configured 256 MiB V8 heap cap does not bound process-tree memory. Native
runtime allocations, VFS state, source/code, host buffers and other runtime
state are outside that single number. This experiment does not apportion each
allocation. The Node baseline's large peak also shows that the 46.6 MB worker
itself is costly to load; the transformed worker is 53.6 MB.

VM disposal leaves substantial resident memory in the process-global native
sidecar. This measurement does not prove a leak: allocators/caches can retain
freed memory. Outer Node GC did not reclaim it. Explicit sidecar disposal did.
A service needs to manage that lifecycle when evicting an instance.

## Shared-sidecar binding failure

The first two-VM run failed and is preserved as `benchmark-2vm-1.json`. Both
VMs' callbacks reached the second VM's host binding handler. The first VM's SQL
service recorded zero calls; the second received both workloads and a database
lock error. This run is **not valid density evidence**.

A standalone probe without OpenClaw reproduces the routing issue:

| Configuration in agentOS 0.2.19 | Observed behavior |
| --- | --- |
| Shared sidecar, same binding names | Both guests invoke the second handler |
| Shared sidecar, unique binding names | First guest's own binding becomes unknown |
| Shared sidecar, one full catalog, per-VM permission rules | First guest's own binding is rejected by the replacement host policy |
| Separate sidecar pools | Each guest invokes its own handler; attempts to invoke the other guest's binding fail |

The integration and benchmark now request a unique sidecar pool per active
core environment. Restoring the same environment can retain its pool. All
bound VMs must be disposed before disposing that pool. These are published
agentOS native subprocesses, not containers or source forks.

The separate-pool two-instance workload passes all twelve core turns with
independent SQL call counts and handlers. This is bounded routing evidence,
not a general security certification, simultaneous turns inside one VM, or a
proof that arbitrary customer workloads are isolated.

A shared dispatcher with capability-based routing would be a larger adapter
design requiring its own authorization tests. It has not been implemented.
Simply allowing every VM to invoke every binding would remove the isolation
property and is not a fix.

## What this means for the architecture

1. Keep the compatibility work, but do not sell the current deployment shape as
   lightweight. A live instance is around a GiB in this experiment, and safe
   two-instance placement is close to linear in memory.
2. Investigate a smaller upstream core entry and profile the first turn before
   scaling this bundle. The Node control establishes a concrete performance
   target and helps separate application costs from adapter/runtime costs.
3. Manage a bounded warm pool and explicitly retire its sidecars. Frequent cold
   recreation currently costs roughly 20 seconds before the first answer, even
   without model latency. Keeping every inactive user resident is not supported
   by these measurements as a cheap strategy.
4. Keep Gateway, channels and Cloudflare deployment out of this phase. These are
   local Node-hosted agentOS results, not evidence of Cloudflare deployability.

No dollar estimate or production instances-per-machine promise follows from
this sample. Memory headroom, concurrent tool processes, longer transcripts,
real model streams, storage growth, host services and failure recovery have not
been capacity-tested. The environment reported an 8-CPU quota and 20 GiB memory
limit; it is shared infrastructure, not a reserved production server.

## Reproduce

Linux is required for the memory sampler. Use the pinned dependencies and Node
version described in the README, then:

```sh
npm run core:build
npm run bench:build
npm run bench:core -- --instances 1 --trial 1
npm run bench:core -- --instances 1 --trial 2
npm run bench:core -- --instances 1 --trial 3
npm run bench:core -- --instances 2 --trial 2
npm run bench:core -- --native --trial 1
npm run bench:core -- --native --trial 2
npm run bench:core -- --native --compiled --trial 1
BENCH_SPLIT_INIT=1 npm run bench:core -- --instances 1 --trial 5
npm run bench:report
npm run probe:bindings
npm run test:core
```

Current driver defaults use separate pools. Historical single-instance trials
1–3 used one VM in the default shared pool; trial 4 adds guest SQL timing and
explicit sidecar disposal. Trial 5 additionally separates the initializer.
The raw failing shared-sidecar run remains a diagnostic control; the standalone
binding probe exercises all four placement/catalog configurations on each run.

The sampler reads `/proc/<pid>/smaps_rollup` every 100 ms and records descendants.
It resolves PID namespaces explicitly because this environment's mounted
`/proc` uses outer PIDs. An initial zero-memory attempt was rejected and rerun;
the sampler refuses to publish zero as valid memory data. PSS prorates shared
pages; summing RSS can double-count shared mappings. Samples can miss short
peaks. Reported idle values are medians while the live guest waits after its
workload; multi-instance idle uses the overlapping idle interval.

Fresh temporary storage is used for each run and deleted afterward. Host file
caches are not flushed. No real model API calls, container launches, production
traffic, cloud deployment, GitHub upload or upstream issue submission occurred.
