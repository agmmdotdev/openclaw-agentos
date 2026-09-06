# Native OpenClaw core with agentOS tools

This is an experimental benchmark backend, not a replacement for the guest-core
runtime. The trusted OpenClaw core and agentOS SDK run in the **same host Node
process**. OpenClaw's existing sandbox filesystem bridge and process supervisor
send file-tool operations and shell execution to a published agentOS sidecar.
There is no additional Node child running the core, no container, and no Rust
fork or change to the installed OpenClaw source.

## Boundary and workload

The benchmark retains the original native OpenClaw tool implementations and
session/inference loop. It injects the existing sandbox interfaces into
`createCoreCodingTools` and redirects the process supervisor's sandbox spawn.
The adapter rejects supervisor requests that would execute a host shell.
The seed exists only in agentOS's chunked-local workspace, and the read and shell
results must contain its contents. Delegation counters confirm 51 reads and 51
shells for every full read+shell run.

Core bootstrap, configuration, SQLite, and transcript handling remain on the
host. The host core and any code it loads are trusted and have host authority.
Routing tools into agentOS does not sandbox that code. This benchmark does not
establish a production security boundary or full tool compatibility. PTY,
background/process follow-up, apply_patch, concurrent sessions, filesystem quota
behavior through the host API, and arbitrary plugin behavior are not validated
by this experiment. No gateway, channels, real provider requests, or model memory
are included.

The independent correctness probe covers original write/edit/read tools,
absence of the created file on the host, denial of a direct outside-workspace
read, shell output and exit code 7, and timeout handling. The published SDK's
spawn timeout did not stop the probe's sleeping command; the adapter therefore
also runs an explicit cancellation timer. This is benchmark code, not a general
replacement for OpenClaw's complete process supervisor.

## Measurement

All runs use OpenClaw 2026.8.1 and agentOS 0.2.19 on Node 24.19.0, two allowed
Linux CPUs, one cold turn plus 50 warm turns, deterministic inference, and a
306-message accumulated transcript. Runs are serial, with two trials per
configuration and reversed ordering. Host file caches are warm. Read and exec
are real tools; the model response is synthetic.

RAM is total process-tree PSS, sampled every 100 ms. Idle RAM is the median in
the first 1.5 seconds after the workload; reported averages are the mean of the
two per-run medians. Warm latency is the mean of per-run medians. CPU covers the
50 warm turns, approximately aligned to samples and including reaped children.
Peak ranges are sampled whole-run maxima and can miss brief spikes. Startup
phase boundaries differ between the harnesses, so their `coldTurnMs` and
`launchToFirstResultMs` fields should not be treated as matched startup measures.

Economy uses one glibc arena, 64 KiB trim/mmap thresholds, and zero warm agentOS
V8 isolates. Memory uses 32 KiB thresholds and zero top pad. Current guest-core
runs use a read-only host_dir for code and chunked_local for writable data.

| Architecture | Profile | Idle PSS MiB | Warm turn ms | Warm CPU seconds | Peak PSS range MiB |
|---|---|---:|---:|---:|---:|
| Guest core | Economy | 468.4 | 374.5 | 23.64 | 554–576 |
| Native core + agentOS tools | Economy | 449.0 | 361.1 | 23.16 | 788–944 |
| Native core + native tools | Economy | 322.5 | 31.0 | 2.27 | 735–744 |
| Guest core | Memory | 403.0 | 460.0 | 29.58 | 536–537 |
| Native core + agentOS tools | Memory | 382.3 | 408.0 | 26.65 | 845–852 |

## Decision

Keep this backend experimental. With economy settings the hybrid reduces idle
PSS by 4.1%, median warm latency by 3.6%, and warm CPU by 2.0%. With the memory
profile it reduces idle PSS by 5.1%, latency by 11.3%, and CPU by 9.9%, but its
measured peak is 845–852 MiB versus 536–537 MiB for the guest core. Two trials
are not enough to establish small differences as reliable production gains.

In the economy hybrid, an idle sample attributes about 329–331 MiB to the host
Node process and 117–121 MiB to the sidecar. Moving the core shifts memory into
Node; it does not remove that memory. The fully native control is much faster,
but its file and shell tools execute on the host. It is a different boundary.
The similar warm CPU and latency between guest and hybrid are consistent with
shell execution in agentOS remaining the dominant cost; these measurements do
not isolate every component of that cost.

## Reproduce

Build the pinned core and benchmark entries, then run the independent probe:

```sh
npm run core:build
npm run bench:build
npm run test:hybrid
```

Run each configuration separately; choose unused trial numbers (the sampler
refuses to overwrite results):

```sh
export BENCH_WARM_TURNS=50 BENCH_CORE_MOUNT=host_dir AGENTOS_V8_WARM_ISOLATES=0
# Economy guest core
python3 scripts/benchmark/measure.py --allocator compact --cpus 2 --trial 821
# Economy hybrid core
python3 scripts/benchmark/measure.py --allocator compact --cpus 2 --native --core --hybrid --trial 821
# Fully native control, including native tools
python3 scripts/benchmark/measure.py --allocator compact --cpus 2 --native --core --trial 821
```

For the memory profile, set `MALLOC_ARENA_MAX=1`,
`MALLOC_TRIM_THRESHOLD_=32768`, `MALLOC_MMAP_THRESHOLD_=32768`, and
`MALLOC_TOP_PAD_=0`, and omit `--allocator compact` (it would override those
thresholds). Trials 831 and 832 use that profile. Repeat each pair in reverse
order. The raw reports and summary are committed alongside this report.

```sh
python3 scripts/benchmark/summarize.py --trials 821 822 831 832 --output hybrid-study-summary.json
```
