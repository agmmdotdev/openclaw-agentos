# Reduce core staging and cold SQL transport

This pass improves startup within the published agentOS 0.2.19 runtime. It does
not close the warm shell-execution gap. No OpenClaw source fork, runtime-binary
change, container or native host command execution is introduced.

## Changes

The core harness now prepares a curated, read-only `/core` directory using the
SDK's public `createHostDirBackend()` mount. It contains only the generated
entry, adapters and parser assets. Workspace and state remain separate durable
`chunked_local` mounts; each tenant still has a dedicated sidecar and SQL service.
Concurrent VMs can share the code directory without sharing their writable data.
The directory survives VM recreation and is removed after its last VM exits.

Previously every VM uploaded a 16.6 MB entry in chunks and launched a guest
Node process to assemble it. Prepared benchmark entries now use a host file copy
without another full-size Node Buffer. The core probe streams the verified
worker and compiled fixture into its entry. Entries still execute through the
guest runtime's streamed entry path; no dependency-response limit is bypassed.
The store accepts only paths beneath `/core`, creates regular files exclusively,
checks the worker hash when composing an entry, and rejects further preparation
after sealing. It does not mount the repository or host node_modules wholesale.

The artifact builder also extracts OpenClaw's original
`collectSqliteNamedIndexContract()` beside the existing table collector. An
exact, hash-pinned guest hook batches up to four reads into one scoped SQL
binding call. The original function body remains the native implementation and
the differential control. Schema repair, validation and migration decisions
remain in the guest. No metadata is cached; uncommitted changes and rollback
remain visible on the caller's connection. The host collector is now 12,884
bytes, SHA-256 `4267743fb38571a73a4198386d6aa40967ca93599639ed6c2edc30a1241be180`.

## Repeated one-VM measurement

Runs **56, 59** retain uploads and table-only batching. Runs **57, 58** enable
both changes, in control/optimized/optimized/control order. Every run executes
one cold and 50 warm real read-plus-shell turns, checks the same output, makes
three inference calls per turn and ends with 306 transcript messages. Both
configurations use the economy environment and the same current worker build.
The control disables only the added index adapter method, preserving its
original guest implementation. Compilation is outside the measurement.

The table reports means of two run-level values; warm latency is the mean of
the two run medians. PSS and CPU include the host and sidecar process tree.

| Measurement | Previous configuration | Both changes |
| --- | ---: | ---: |
| Code staging wall time | 492 ms | 16 ms |
| PSS after staging | 160.1 MiB | 145.6 MiB |
| Cold SQL binding calls | 1,700 | 1,373 |
| Launch to first result | 3.58 s | 3.24 s |
| Staging plus cold-turn CPU | 5.14 CPU-s | 4.33 CPU-s |
| Idle PSS after 51 turns | 459.5 MiB | 452.9 MiB |
| Peak PSS | 555.1 MiB | 545.0 MiB |
| Full measured lifecycle CPU | 31.65 CPU-s | 30.95 CPU-s |
| Warm-turn median | 330 ms | 336 ms |
| CPU across 50 warm turns | 24.34 CPU-s | 24.54 CPU-s |

The durable result is less staging work and **327 fewer cold binding calls**.
First-result time is about 9% lower; staging plus cold-turn CPU is about 16%
lower. Staging and launch are separate intervals, so the first-result figure
does not include the additional approximately 476 ms saved before launch.

Steady memory is less decisive: idle ranges overlap (453.8–465.2 MiB before,
444.6–461.2 after), as do peak ranges. The average idle saving is only 6.6 MiB.
Warm CPU and latency show no improvement. Full-lifecycle CPU is only about 2%
lower because warm shell execution still dominates this workload. These two
repetitions do not establish a general steady-state memory or CPU improvement.

A fresh direct-Node comparison (**native-core-16**, the same current native
artifact and 51-turn fixture) reaches its first result in 1.03 s, has a 24.5 ms
warm median, uses 1.93 CPU-s across the 50 warm turns and idles at 323.4 MiB PSS.
It is one baseline run, not a repeated Node distribution. The roughly 336 ms /
24.54 CPU-s guest warm result remains far from Node; this pass improves staging
and cold inspection rather than the dominant shell runtime boundary.

Single six-turn ablations **60** (mount only) and **61** (index batching only)
retain respectively 1,700 and 1,373 cold SQL calls. Staging CPU measures about
0.02 versus 0.51 CPU-s. Cold-turn CPU is 4.65 versus 4.36 CPU-s. Their launch
latencies vary enough that they are not independent evidence of latency gains.
The 100 ms CPU sampler can report zero for the 16 ms mounted staging interval;
that does not mean copying files uses no CPU.

Two concurrent VMs also pass with one shared code store and separate sidecars,
SQL services and durable data mounts. In the single six-turn-per-VM pair
**2vm-6/2vm-7**, staged PSS falls from 220.5 to 162.8 MiB, idle PSS from 735.3
to 712.2 MiB, and peak PSS from 955.6 to 911.9 MiB. Full CPU is 26.94 versus
17.01 CPU-s, but the control has unusually slow 6.5–6.7 s first results versus
3.5–3.6 s in the optimized run. This pair verifies sharing and supplies scaling
measurements; it does not establish a repeatable 37% CPU improvement.

Exploratory runs **54, 55** precede the final store implementation and index
batching and are excluded from this comparison. All runs and failures are
retained. The CPU accounting and timestamp alignment are described in
[the runtime-boundary report](runtime-bottlenecks.md).

## Correctness and limits

The real core probe passes 132 capability assertions, read/write/edit/exec and
apply-patch, eight failure/background cases, continuation, restored-VM state,
two explicit unsupported-profile boundaries and three schema differential
states. The mounted code store is prepared once and reused after recreation.
The host differential test covers partial, unique, expression, implicit and
missing indexes, replacement inside a transaction, rollback, hostile names,
invalid input, foreign handles and closed handles.

The mount test uses two dedicated sidecars with the same code store, including
guest uid 0 and uid 1000. It checks imports and file reads; rejects write,
append, unlink, rename, symlink, hardlink, chmod, truncate, mkdir and writable
open attempts; and verifies private writable data and unchanged host contents.
The published runtime wraps truncate's EROFS in an RPC error rather than a
Node-identical error object. That limitation is recorded in the assertion.

An exploratory store used mkdtemp's default 0700 root. The streamed worker ran,
but guest parser reads failed with EACCES and OpenClaw continued through its
fallback. That result is explicitly marked invalid in
`core-probe-host-dir-permission-failure.json`. The store now gives its code-only
root mode 0755 and files mode 0444; the native mount also enforces read-only
access. Parser-load errors now fail the probe, benchmark and compatibility
summary even if tool output passes. Host-side artifact preparation is trusted;
this is not protection against a malicious host modifying its own files.

## Reproduce

```sh
npm run core:build
npm run bench:build
npm run test:core-artifacts
npm run test:core-profile
npm run test:host-sqlite
npm run test:core:economy
npm run core:report

# Previous configuration, current artifact with only index batching disabled.
BENCH_WORKLOAD=core-shell BENCH_SQL_SCHEMA_MODE=table-only BENCH_CORE_MOUNT=upload BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 80
# Current configuration.
BENCH_WORKLOAD=core-shell BENCH_CORE_MOUNT=host_dir BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 81
python3 scripts/benchmark/summarize.py
```

Use unused trial numbers. `CORE_ARTIFACT_MODE=upload npm run test:core:economy`
retains the old upload path for compatibility investigation. The benchmark
defaults to upload to preserve existing commands; select `BENCH_CORE_MOUNT`
explicitly. The ordinary core probe now defaults to the read-only mount.
