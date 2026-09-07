# Startup-tail investigation and a single-start request launcher

This follows PR #15. The historical 41-second and 5.689-second startup stalls
were **not reproduced or explained**. The investigation did identify a separate,
repeatable cost: the JavaScript request launcher starts Node, then uses `execve`
to start Node again with the desired V8 flags and allocator environment.

The new `scripts/run-core-node-request.sh` starts Node once. It sets the same
allocator environment and V8 flags, and preloads a small version guard before
the core entry. Matched uninstrumented trials show **8.5% less CPU** and **5.6%
lower subsequent-request latency**, with essentially unchanged sampled peak RAM.
This is a normal-startup improvement, not a claimed fix for the rare stalls.

## What the diagnostics establish

The lifecycle harness now accepts `--startup-diagnostics phases` or `cpu`.
A separately generated entry adds checked markers around module evaluation,
SDK import, SDK creation, embedded initialization, checkpoint restore and
`worker-ready`. A Node preload marks the earlier boundary without installing
module-loader hooks. Markers include monotonic time, process CPU and memory.
A performance observer records GC intervals; CPU mode also writes V8 profiles
with a 1 ms sampling interval.

| Diagnostic trial | Core layout | Instrumentation | Requests | Warm ready median ms | Warm ready maximum ms |
|---|---|---|---:|---:|---:|
| 2000 | Bundled lazy | Phases + CPU profiler | 31 | 2,212 | 2,481 |
| 2001 | Bundled lazy | Phases only | 31 | 1,952 | 2,173 |
| 2002 | Split lazy | Phases only | 31 | 1,925 | 2,115 |

The 60 warm phase-only requests stayed within approximately 12% of their
respective median startup times. There was no isolated event comparable to the
previous 4.916-second delay before `worker-ready`, nor the earlier 41-second
stall. None of these results proves that those stalls have disappeared.

The CPU profiles place substantial sampled startup time in Node's
`compileSourceTextModule`, native module construction, UTF-8 decoding and GC.
SDK import/creation and checkpoint restore are smaller phases in these runs.
This describes ordinary startup on this host; it does not identify the cause of
an outlier that was not captured. Profiles cover the main thread and do not
provide background compiler-thread stacks. The GC observer is not a complete
trace of native V8 allocation.

Profiling perturbs execution, and even phase markers change the generated
entry. The initial comparison with the previous day's roughly 1.3-second
requests was misleading: fresh, uninstrumented controls in this session take
roughly 3.28 seconds. This session is slower across ordinary requests as well.
The environmental reason is unresolved; improvement percentages below compare
only matched controls from this session. They must not be chained directly onto
the previous day's timings.

All 93 diagnostic requests pass their real-tool, checkpoint, file and descendant
cleanup assertions (465 real tool calls). The raw 31 CPU profiles are retained
as lossless gzip files. The summary tool reads either plain or gzip profiles,
checks profile/marker clock alignment and records the SHA of the original bytes.
One profile contains a backwards 13-microsecond sample interval: the summary
preserves its timestamp, gives that interval zero weight and records the anomaly.

## Single-start implementation

The new shell launcher performs environment setup, then `exec node` with
`--max-semi-space-size=8 --liftoff-only --import .../request-profile-guard.mjs`.
The guard rejects runtimes outside Node 24.19.0 / Linux x64 before loading the
core entry. The Wasm compiler policy, tools, native core, schema/highlighter
initialization and request checkpoint protocol are unchanged. This introduces
no resident worker, proxy, Node API shim or extra daemon.

`--profile request` in the lifecycle harness now selects this launcher by
default. The original `.mjs` launcher is retained byte-for-byte as the
`--request-launcher execve` control. Ordinary optimizing-Wasm runs are unchanged;
the baseline-Wasm request profile is still opt-in with its previously measured
parser-throughput tradeoff. The native SDK request probe also uses the new
launcher.

## Matched uninstrumented comparison

Trials 2010/2011, 2020/2021 and 2030/2031 run serially, with reversed launcher
order in the middle pair. Both launchers execute the same bundled lazy SDK
benchmark entry, seven turns / 35 real tool calls, using the same two allowed
CPUs, allocator and V8 settings. Each trial starts with an empty compile cache.
There are no phase markers, GC observers or CPU profilers in these six trials.

| Cached native requests | Legacy Node + execve | Single Node startup |
|---|---:|---:|
| CPU / 7 turns | 23.50 s | 21.51 s |
| Subsequent process median | 3,280 ms | 3,096 ms |
| First process median | 3,923 ms | 3,735 ms |
| Median sampled peak PSS | 223.9 MiB | 224.7 MiB |
| Idle core memory after exit | 0 | 0 |

Numbers are medians of per-trial summaries. CPU ranges are 23.26–23.62 seconds
legacy and 20.90–22.34 seconds single-start. Subsequent process median ranges are
3,243–3,281 ms legacy and 2,988–3,124 ms single-start. Both metrics improve in
all three pairs. Peak ranges overlap (223.86–225.45 versus 222.98–224.67 MiB);
there is no demonstrated memory saving. Actual warm tool-turn medians remain
similar, consistent with removing work before the request runs.

A separate seven-request phase-only followup (2040) passes another 35 real
tool calls. The parent-start-to-final-Node-clock gap estimated at the preload
marker falls from roughly 279 ms in bundled legacy trial 2001 to 51 ms with the
single-start launcher. This estimate includes process setup and marker delivery;
it is supporting evidence for the removed bootstrap, not precise OS exec timing
or another matched performance comparison. Its warm ready median is 1,669 ms,
maximum 1,762 ms, without an isolated spike.

All six trials pass, with 210 real tool calls, exact persisted histories/files,
normal exits and no surviving descendants. Every turn contains 420 ms scripted
inference. The external Python sampler is excluded; PSS sampling is every 40 ms
and can miss short peaks. These numbers are not production capacity estimates.

## Verification and reproduction

Three launcher tests cover rejected runtime versions/platforms/architectures,
paths and arguments containing spaces/Unicode, cwd, allocator flags, stdin,
stdout/stderr, exit status, evaluation and preload failure before entry.
The 19-case real Bash parser differential matches ordinary Node, legacy request
launching and single-start launching, including malformed and oversized input.
Three checkpoint tests and the native SDK real-tool probe pass. The parser test
now uses unique temporary filenames to avoid stale files after a restarted
test process reuses a PID.
Across diagnostics, matched comparisons and the final phase-only check, all
142 requests / 710 real tool calls pass. All seven focused tests pass.

```sh
npm run core:build
npm run bench:build
npm run test:request-launcher
npm run test:parser-startup
npm run test:request-state
npm run test:native-sdk:request

# Use unused trial numbers and run comparisons serially, alternating order.
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 2050 --profile request --initialization bundled --request-launcher execve
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 2051 --profile request --initialization bundled --request-launcher single

# Separate diagnostic run; these timings are not the performance comparison.
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 31 --trial 2060 --profile request --initialization bundled --startup-diagnostics cpu
python3 scripts/diagnostics/summarize-startup-tail.py 2060 --compress-profiles
```

For your own entry, invoke `sh scripts/run-core-node-request.sh your-entry.mjs`.
Keep the launcher and `core/request-profile-guard.mjs` in their relative layout,
and use the supported Node executable on `PATH`.

The next tail investigation should collect more phase-only runs, enabling CPU
profiles in a separate reproduction once a repeatable slow phase emerges. No
timeout/retry or automatic replay is added to hide these stalls. The backend
remains trusted-only; Linux sandbox enforcement and live model inference are
outside this result.
