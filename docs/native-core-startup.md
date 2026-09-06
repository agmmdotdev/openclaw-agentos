# Native core startup: identify and avoid the Wasm compiler peak

Continuation after PR #12 was merged into main at `6d1e52f`.

The opt-in request profile reduces median sampled peak PSS from **673 to 237 MiB**
and seven-request CPU from **10.06 to 8.07 seconds** in three paired trials.
It keeps the original OpenClaw core and Bash parser, using V8's baseline Wasm
compiler instead of its optimizing compiler. This is a trusted-core experiment,
not completion of Linux sandbox acceptance.

## What the profiling established

JavaScript loading is still substantial. An initial CPU profile spent about
369 ms in `compileSourceTextModule`; a separate instrumented initializer run
measured 190 ms in the embedded initializer and 93 ms in eager evaluation.
Large contributors include terminal highlighting and Zod schemas. The first
parser load itself took about 10 ms, and its first parse about 5 ms. These
instrumented measurements are diagnostics, not the performance comparison.

The large memory spike happens later. A 10 ms memory timeline shows RSS rising
from approximately 225 MiB toward 600 MiB while JavaScript heap allocation
stays near 95 MiB and reported external memory stays near 65 MiB. A Linux/glibc
allocation interposer records growing native allocations of 41,091,104,
82,182,176, 164,364,320 and 328,728,608 bytes. Symbolized frames lead through
Turboshaft snapshot-table merging and loop unrolling to
`ExecuteTurboshaftWasmCompilation` and its background compilation worker.

V8's own compilation trace confirms the cause in an isolated parser diagnostic:
Bash grammar function #22, with a 159,934-byte body, takes **343 ms** to optimize
and reports **694,444,232 maximum / 789,841,272 total compiler allocation bytes**.
Those are V8 diagnostic counters, not physical process memory; do not add them
to RSS. The grammar's largest code body matches that size. The request profile
has no TurboFan compilation in the recorded parser trace.

This explains the repeated transient memory peak in the measured workload. It
does **not** establish the cause of PR #12's isolated 40.99-second startup before
`worker-ready`; that historical tail-latency outlier remains unresolved.

## Implementation and scope

`scripts/run-core-node-request.mjs` uses `process.execve`, so no launcher process
remains. It sets the existing compact allocator environment and 8 MiB semi-space
cap, plus `--liftoff-only`. Node's baseline Wasm compiler still executes the real
parser; the parser is neither removed nor replaced. JavaScript optimization and
the spawned Node tool commands retain their existing behavior.

`--liftoff-only` is an internal V8 flag described by V8 as a testing option. The
launcher therefore accepts only the measured **Node 24.19.0 / Linux x64** and
requires revalidation elsewhere. It is explicitly opt-in. It affects all Wasm
inside that core process, so parser-heavy or other Wasm-heavy workloads may lose
optimized throughput. The historical launchers retain their existing flags.
The SDK does not acquire a global flag or launch an original agentOS sidecar.

Node's compilation cache remains optional and caller-owned. It caches JavaScript
compilation; it does not remove eager object initialization or provide a prepared
heap snapshot. This launcher does not itself implement an inference server,
request transport, scheduler, or eviction policy.

The lifecycle runner now accepts the profile, records its launcher hash and
effective compiler configuration, and retains explicit diagnostic alternatives.
The startup profiler instruments actual ESM/CommonJS initializer execution with
inclusive and exclusive times and can record V8 Wasm compilation traces.

## Matched results

Three serial trials per configuration, seven turns / 35 real tool calls each.
The order alternates default/request and request/default across repetitions.
Every run uses the same generated core entry, two allowed CPUs, allocator
settings, 8 MiB semi-space cap, workspace workload, and scripted inference.
Compilation caches start empty per trial. No allocation interposer, CPU profiler,
initializer wrapper, forced GC, or trace is enabled in these comparisons.

| Native SDK execution | Core profile | Peak PSS range MiB | Idle core PSS MiB | CPU / 7 turns s | Subsequent process median ms | Resident warm-turn median ms |
|---|---|---:|---:|---:|---:|---:|
| Request + compile cache | Default | 659–693 | 0 | 10.06 | 1,491 | — |
| Request + compile cache | Request | 233–238 | 0 | 8.07 | 1,379 | — |
| Resident | Default | 660–684 | 235.0 | 2.66 | — | 581 |
| Resident | Request | 244–247 | 232.8 | 2.43 | — | 591 |

Values other than peak ranges are medians of per-trial summaries. The request
profile cuts median request peak PSS **64.8%**, total CPU **19.8%**, and subsequent
process latency **7.5%**. The first process medians are 1.818 versus 1.743 seconds.
It does not remove the fundamental lifecycle tradeoff: cached requests still use
about **3.3 times** the seven-turn resident CPU with this profile.

Resident idle memory is essentially unchanged; median warm-turn time is about
1.7% higher. This short workload does not establish parser-heavy throughput.
Each turn contains 420 ms of scripted inference. Resident runs also include
1.5 seconds of idle observation. The external Python sampler is excluded;
40 ms sampling may miss short physical peaks. Zero idle core memory means the
core and its children exited, not that the gateway, OS, or page cache use no RAM.

All 12 comparison trials pass: 420 real tool calls, exact file/history checks,
normal exit and no surviving children. Trial 1760 additionally completes 21
fresh cached processes / 105 tools, preserving 276 messages, 21 reports and
252 transcript events. It uses 25.17 seconds CPU, a 1.444-second subsequent
process median, and a 230 MiB sampled peak. It is a continuity followup, not a
substitute for the seven-turn matched comparison.

## Compatibility and rejected alternatives

- All 48 SDK tests and three checkpoint tests were rerun successfully before
  merging PR #12. The new work does not change those implementations.
- The original and request-profile native-SDK OpenClaw tool probes pass, including
  persistent write/edit/read, shell output, exit code 7, and timeout.
- A differential test compares the real parser's complete node types, spans,
  positions, child structure and error flags under both profiles across 19 cases:
  pipelines, redirections, substitutions, heredocs, functions, loops, Unicode,
  malformed input, and a 1,500-line script. The 128 KiB source limit still rejects
  oversized input. This does not establish exhaustive Bash-language compatibility.
- Type checking and the existing 11 provider/configuration unit tests pass.

Exploratory three-request trials are archived but excluded from the comparison:
1700 default; 1701 `--no-wasm-tier-up`; 1702 JavaScript `--max-opt=1`; 1703
`--liftoff-only`; 1704 no Wasm loop unrolling; 1705 no loop unrolling or peeling.
The first two compiler caps did not eliminate the peak. Disabling loop transforms
alone retained roughly 500 MiB peaks. Only the baseline-only Wasm profile reduced
the peak to roughly 233 MiB in these diagnostics. In particular, the diagnostic
label `wasmTiering: off` records the supplied `--no-wasm-tier-up` flag; it is not
evidence that all optimizing Wasm compilation was disabled.

## Reproduction

```sh
npm run bench:build
npm run test:parser-startup
npm run test:native-sdk:request
node scripts/diagnostics/profile-native-startup.mjs 1800 --trace-wasm
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 1801
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 1802 --profile request
# Repeat serially with unused trial numbers and alternating order.
# For resident comparisons use --mode resident with the same two profiles.
```

Application-owned cache, with an already prepared native entry:

```sh
NODE_COMPILE_CACHE=/path/to/private/compile-cache node scripts/run-core-node-request.mjs your-native-core-entry.mjs
```

Rebuild the native allocation diagnostic with:

```sh
cc -shared -fPIC -O2 scripts/diagnostics/native-allocation-probe.c -o /tmp/core-allocation-probe.so
LD_PRELOAD=/tmp/core-allocation-probe.so python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request --turns 2 --trial 1803
```

That last command is instrumented; exclude it from performance summaries. Its
large allocation stacks appear in each run's logs. Use `addr2line -f -C -e` with
the same Node executable and recorded addresses to symbolize them. The interposer
is Linux/glibc-specific and observes allocations, not a complete memory census.

Evidence: `artifacts/results/native-startup-summary.json`, matched lifecycle
trials 1720–1723 / 1730–1733 / 1740–1743, followup 1760, initializer diagnostics
1750/1751, `startup-allocation-*`, `startup-memory-*`, `startup-request.cpuprofile`,
and `startup-*-tests.txt`. Diagnostic provenance retains the measured interposer
source and core/entry hashes. Historical results are retained unchanged.

## Next work

The largest remaining repeated-start cost is loading/initializing the 14 MiB
JavaScript core. Investigate deferred terminal-highlighting and configuration
schema initialization without changing required registrations or validation.
Measure more demanding parser/skill workloads before choosing this profile for
long-lived cores. Linux enforcement, interrupted-request recovery policy and a
general inference service remain separate unfinished milestones.
