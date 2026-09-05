# OpenClaw / agentOS: current measured boundary

The latest [memory and CPU pass](runtime-memory-cpu.md) adds an opt-in economy
profile. Across two 51-turn runs per mode, idle process-tree memory falls from
568 to 468 MiB (18%) and sampled peak from 661 to 562 MiB (15%). Complete
lifecycle CPU falls only about 3%; steady-state CPU improvement is not
established. The same reduced core on direct Node measures 324 MiB idle and
3.38 CPU-seconds for the full workload, versus about 30.16 CPU-seconds on agentOS.

The reduced guest core remains **16.6 MB**, compared with the original compiled
53.6 MB. The preceding schema-batching measurements are preserved below.

## Schema-batching comparison

The two agentOS configurations below use the same built artifact, allocator
settings and workload. The individual control disables only the new metadata
method during staging, retaining the original query-by-query implementation.

| Configuration | Runs | Median launch → first result | Observed range | Median of warm-turn run medians | Idle PSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| agentOS, individual metadata queries | 3 | 4.46 s | 4.14–4.52 s | 314 ms | 522–545 MiB |
| agentOS, batched upstream collector | 5 | 3.50 s | 3.40–6.14 s | 308 ms | 520–547 MiB |
| Same reduced core on direct Node | 1 | 1.17 s | 1.17 s | 27 ms | 272 MiB |

Batched runs are trials **19, 23, 24, 25 and 27**. Individual controls are
**20, 26 and 28**. The current Node baseline is native-core trial **5**.

Median first-result latency improves by **21%**. Including the 6.14-second
outlier, the mean improves from **4.37 to 4.02 seconds**, about **8%**. This
small sample supports the transport reduction and a typical cold-start gain;
it does not support a stable tail-latency guarantee. The previous Node repeats
measured 1.00–1.22 seconds with 26–29 ms warm turns, consistent with the current
one-run reference. Do not interpret the small warm difference between agentOS
modes as an established improvement.

Cold binding calls fall from **3,306 to 1,700** on every compared run. Median
guest SQL elapsed time falls from **2.13 to 1.27 seconds**, while host SQL work
remains near 0.2 seconds. Schema collection still reads real database metadata;
comparison, drift detection, migration decisions and integrity checks remain.

Trial 24 passed and made the expected 1,700 calls, but its cold turn after ready
took 5.48 seconds and SQL calls accumulated 1.73 seconds. We have not identified
the cause of all the additional elapsed time. The outlier is included in both
aggregate calculations and the raw report.

Two concurrent batched instances (trial **2vm-4**) also pass, with independent
sidecars and SQL handles. First results take **3.84–3.95 seconds per instance**,
pooled warm median is **344 ms**, and idle process-tree PSS is **922 MiB total**.
The prior unbatched two-instance run measured 4.87–4.98 seconds, 405 ms and
901 MiB. These one-run comparisons show successful operation and a cold gain;
they do not establish a density or memory improvement.

## Why this boundary helps

OpenClaw's collector asks SQLite for table definitions, table options, indexes,
index terms and triggers. Previously each native database call crossed the
synchronous binding CLI. The generated adapter now invokes the **unchanged
collector function** on the host's already-authorized database handle and
returns one typed result. A Map wire type preserves column definitions.

The extracted module is **12,477 bytes**, has no imports and opens no databases.
Its hash is recorded at build time and verified at host load. The guest hook
adds **98 bytes**. No metadata-result cache is used. The full implementation,
constraints and tests are in [schema-batching.md](schema-batching.md).

Correctness evidence includes direct-Node differential collection and real
in-guest comparisons of complete table contracts and schema issues across
canonical schemas, deliberate drift and rollback. Tests cover Unicode column
ordering, strict/WITHOUT ROWID tables, quoted identifiers, triggers, expression
and partial indexes, FTS tables, foreign handles and closed handles. The core
runtime gate passes, including **132 capability assertions**, tool failure and
background cases, read-only restrictions and VM restoration.

## What still dominates warm turns

Process-event profiling in trial **21** measures warm `/bin/sh` exits at
**189–233 ms** after the spawn call begins. The spawn event arrives at 12–14 ms.
This includes command execution and runtime event delivery; it is not a pure
CPU measurement. Complete warm turns remain around 0.3 seconds, compared with
about 27 ms on Node.

That evidence points to the published shell/process path as the next meaningful
warm-latency target. Further trimming of unused OpenClaw modules cannot be
assumed to remove that interval. A shortcut that replaces the benchmark's
shell command with a file read would change semantics and was not used.
Any persistent-shell or direct-execution design would need to preserve fresh
process state, cancellation, output ordering and process ownership before it
could count as an equivalent improvement.

The remaining cold SQL calls include table-existence, index and rowid
inspection, plus state and migration work. We kept those intact rather than
adding several new private hooks for progressively smaller gains in this pass.

## Measurement method and provenance

The workload is unchanged: real `read` and shell `exec` tools, three
deterministic inference calls per turn, transcript commits, five warm
continuations, and SQL calibration. No model-network latency is included.

Launch excludes compilation, VM provisioning and staging. Native Node timing
starts at OS process creation; agentOS timing starts when the staged guest entry
is submitted. PSS includes the Node host and all native sidecars, sampled every
100 ms through `/proc`. Raw reports also include RSS, approximate process-tree
CPU ticks, events, effective allocator variables, diagnostic flags and build
hashes. The sampler rejects zero-memory collection failures.

The compact allocator profile sets `MALLOC_ARENA_MAX=1`,
`MALLOC_TRIM_THRESHOLD_=65536` and `MALLOC_MMAP_THRESHOLD_=65536` before host
launch, and applies equally to Node and agentOS comparisons. It requires glibc;
it is not a runtime-binary change. Fresh storage is used, but host file caches
are not flushed. Small samples on shared infrastructure are not production
capacity, p95 or billing evidence.

Trial **22** records SQL-query frequency and is excluded from performance
aggregates. Trial **21** records core/process timing and is also excluded.
The metadata-disable controls are included only as the individual comparator.
The summary identifies native, guest-individual and host-batched execution.

The [first size/allocator pass](runtime-benchmark-size-pass.md) preserves the
69% artifact reduction, shell timeout fix and allocator investigation. The
[original baseline](runtime-benchmark-baseline.md) preserves full-worker
measurements and the shared-sidecar binding failure. Shared binding modes
remain unsupported; keep separate pools and dispose sidecars on eviction.

These results remain a local Node-hosted agentOS prototype. No containers,
OpenClaw source fork, agentOS source changes, Rust build, Gateway implementation,
GitHub upload or Cloudflare deployment were introduced. Direct Node retains a
clear advantage on equivalent reduced-core memory and warm latency.

## Reproduce

```sh
npm run core:build
npm run test:core-profile
npm run test:core:compact
npm run test:host-sqlite
npm run core:report
npm run bench:build
npm run bench:core -- --instances 1 --allocator compact --trial 60
BENCH_SQL_SCHEMA_MODE=individual npm run bench:core -- --instances 1 --allocator compact --trial 61
npm run bench:core -- --instances 2 --allocator compact --trial 60
npm run bench:core -- --native --core --allocator compact --trial 60
npm run bench:report
```

See [schema-batching.md](schema-batching.md) for profiling commands. Choose new
trial numbers to retain previous raw results. Installed dependencies and large
regenerated artifacts are excluded from the source archive; the build scripts,
fixtures, reports and git history are included.
