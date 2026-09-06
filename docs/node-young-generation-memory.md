# Reduce retained core RAM with a smaller Node young generation

An opt-in 8 MiB V8 semi-space cap reduces native-core idle PSS by **26.4%**
and hybrid idle PSS by **24.4%** in repeated, matched single-core benchmarks.
The hybrid's warm CPU cost increases **4.5%** and median turn latency **3.5%**.
This changes host Node garbage-collection sizing. It adds no multi-tenant
implementation, removes no tools, and does not modify OpenClaw or agentOS.

## Matched results

Each configuration has two serial runs, with baseline/candidate/candidate/
baseline ordering within each architecture. Trials 911/914 are controls;
912/913 use `--max-semi-space-size=8`. All eight runs pass the original real
read + shell fixture: one cold turn, 50 warm turns, 306 accumulated transcript
messages, deterministic inference, two allowed Linux CPUs. Diagnostics and
forced garbage collection are disabled in these comparisons. The native and
hybrid measured processes both expose GC, but the fixture does not call it.

| Core architecture | Host semi-space | Idle PSS MiB | Median warm turn ms | CPU for 50 warm turns s | Peak PSS range MiB |
|---|---|---:|---:|---:|---:|
| Native core + native tools, economy allocator | Default | 324.4 | 26.7 | 1.89 | 593–735 |
| Native core + native tools, economy allocator | 8 MiB | 238.7 | 27.1 | 2.04 | 671–695 |
| Native core + agentOS tools, memory allocator | Default | 386.0 | 373.8 | 23.88 | 885–919 |
| Native core + agentOS tools, memory allocator | 8 MiB | 291.9 | 386.9 | 24.96 | 826–863 |

Idle PSS and warm latency average the per-run medians. Idle is the same first
1.5 seconds after the workload. PSS covers the whole process tree; CPU includes
reaped children and is approximately aligned to 100 ms samples. Peak values
are sampled maxima and may miss brief spikes. The small CPU differences and
peak ranges require caution with only two trials. Raw samples and the exact
allocator environments are retained in `artifacts/results`.

The hybrid now fits below our **old** native baseline, but the same optimization
also benefits native Node. Optimized native is still smaller at 239 MiB versus
292 MiB hybrid. These results do not establish capacity for a 4 GB server:
peak RAM, concurrency, real contexts and the deployment's detected memory limit
still need their own measurements. No gateway or provider/model RAM is included.

## Diagnosis

Opt-in trial 901 records Node memory and V8 heap-space/code statistics. After
50 warm turns it reports:

- RSS 325.8 MiB; heap allocated 212.1 MiB; heap used 94.7 MiB.
- `new_space` size 128 MiB, used 11.7 MiB, physical size 107.1 MiB.
- `old_space` used 66.2 MiB; external memory 65.1 MiB.

External memory and source/code statistics overlap other accounting categories;
these figures must not be added together as independent RSS components.

Trial 903 caps semi-space at 8 MiB. Allocated heap falls to 100.6 MiB and RSS
to 235.7 MiB. This is evidence that a large part of retained RAM was young-
generation capacity, not additional application state. The flag controls a
semi-space, **not an 8 MiB total heap limit**. Node documents its memory/throughput
tradeoff and notes that the default depends on available memory:
[Node CLI documentation](https://nodejs.org/api/cli.html#--max-semi-space-sizesize-in-mib).

This was measured on Node 24.19.0 with OpenClaw 2026.8.1 and agentOS 0.2.19.
Recheck on deployment and upgrades; host memory detection affects defaults.
The flag is supplied to host Node only. Guest V8 heap/resource limits remain
unchanged. The guest-core architecture was not re-benchmarked in this pass.

## Controls and rejected alternatives

Trial 902 forces one full GC at idle, outside the warm workload. Used heap falls
from about 95 to 75 MiB, but RSS remains about 327 MiB. Collection takes about
73 ms. Forced GC is retained only as a diagnostic, not enabled by the launcher.

A 4 MiB semi-space trial (904) does not materially improve RAM over 8 MiB in
this workload. The selected 8 MiB cap leaves more young-generation room.

Peak samples in native and hybrid runs show large transient allocations in the
host Node process. Diagnostic compiler-tier caps (`--max-opt=1` and `2`, trials
921/922) do not establish a reliable peak fix. Tier 1 has a slower 32.2 ms warm
median versus approximately 27 ms for the selected profile. These internal V8
flags remain diagnostic options only; the launcher does not change compiler
tiers. The exact owners of the transient peak remain unresolved.

## Run and verify

The launcher combines the existing memory allocator environment with the new
host flag and uses execve, so it does not retain an additional launcher process:

```sh
node scripts/run-core-node-memory.mjs your-native-core-entry.mjs
```

It is opt-in for the native/hybrid experiment. Existing guest launchers and the
default runtime stay unchanged. The hybrid's trusted-host boundary and incomplete
production compatibility remain as documented in
[native-core-agentos-tools.md](native-core-agentos-tools.md).

```sh
npm run bench:build
npm run test:hybrid:memory
```

The real-tool probe passes write/edit/read, guest-only file creation, direct
outside-workspace path denial, shell stdout and exit code 7, and cancellation
on timeout through the new launcher. All performance trials also verify tool
results and transcript completion; hybrid delegation counts are 51 reads and
51 shells per run. This is not a claim of full untested tool compatibility.

To reproduce the native comparison, run with and without the final flag, using
unused trial numbers:

```sh
BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --native --core --allocator compact --cpus 2 --trial 912 --node-semi-space-mb 8
```

For the hybrid comparison, add `--hybrid`, omit `--allocator compact`, and set
`MALLOC_ARENA_MAX=1`, `MALLOC_TRIM_THRESHOLD_=32768`,
`MALLOC_MMAP_THRESHOLD_=32768`, and `MALLOC_TOP_PAD_=0`. Repeat both conditions
in reverse order, serially. Do not run diagnostics alongside measured trials.

```sh
python3 scripts/benchmark/summarize.py --trials 911 912 913 914 --output node-semi-space-comparison.json
```

For diagnostic heap-space checkpoints, set `BENCH_NATIVE_MEMORY=1`. Adding
`BENCH_GC_AT_IDLE=1` requests a full GC before the idle checkpoint; the native
sampler starts Node with `--expose-gc`. Diagnostic results should not be mixed
with uninstrumented performance comparisons.
