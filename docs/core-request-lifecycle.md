# Request-based native core: compatibility and measurement

This milestone runs the existing OpenClaw core and real read/edit/write/exec tools in a fresh Node process for each request. The filesystem and transcript survive; the core exits normally after its turn. No gateway, tenant scheduler, production inference client, or protected Linux execution is added.

## Implementation

- `packages/openclaw-core/src/request-state.mjs` (moved from `scripts/core/request-state.mjs` in the [source ownership follow-up](source-optimization-migration.md)): a reusable single-session checkpoint lease. Exclusive pending-file creation prevents concurrent admission. Completed messages are written to a temporary file, synced, renamed, and the directory synced before clearing the pending marker. Sequence checks reject duplicate, missing, corrupt, and out-of-order checkpoints.
- An interrupted turn deliberately leaves its pending marker. Tool effects and transcript publication are not one transaction; automatic replay could repeat an action. The helper requires explicit recovery and does not offer exactly-once execution or automatic stale-lease reclamation. Even a crash just after checkpoint publication can require recovery.
- `BENCH_REQUEST_TURN` enables the representative fixture to restore the checkpoint, verify history length and workspace version, execute one turn, and commit it. Restarts never reseed an existing session. A mismatch fails with the pending marker intact.
- `scripts/benchmark/request-lifecycle.py`: external Linux process-tree sampling, serial requests, CPU accounting, normal-exit verification, final workspace/history validation, and a test subreaper to detect/reap trusted orphan descendants. No forced `process.exit()` hides lingering handles.
- The core build remains the pinned reduced OpenClaw 2026.8.1 artifact. There is no change to OpenClaw's inference or coding-tool implementation.

The state directory must be application-owned, on a local filesystem with the required rename/fsync semantics. This is trusted-host infrastructure, not a filesystem access-control mechanism. Checkpoints are capped at 32 MiB. Cross-process power-loss recovery and concurrent checkpoint readers are not validated here.

## Compatibility scope

| Surface | Native SDK | Pinned upstream agentOS 0.2.19 |
|---|---|---|
| Filesystem CRUD, metadata, move, persistence | Tested | Shared contract tested |
| Captured stdout/stderr, nonzero exit | Tested | Shared contract tested |
| Environment/argument boundaries, stderr-only capture | Tested | Shared contract tested |
| Timeout result | Tested | Shared contract tested |
| ESM file with relative import | Tested | Shared contract tested |
| `exec('cat', {stdin})` EOF completion | Completes with exact Unicode output | Observed timeout; tracked as an upstream limitation |
| CommonJS/ESM conditional package exports and file argv | Native Node tests | Not established by this milestone |
| Restarted OpenClaw history and workspace continuity | Real tools, scripted inference | Not measured in request mode |
| PTY, sessions/contexts, bindings, other language runtimes | Still deferred/explicitly unsupported | Outside this extraction's contract |

The upstream timeout is an explicit expected limitation in the test, not a passing EOF compatibility claim. Matching its failure would make the native implementation worse.

## Filesystem allocation optimization

The Node filesystem adapter previously allocated 64 KiB chunks even for tiny files, then concatenated the result into another buffer. It now sizes the initial buffer from the regular file's size plus an EOF probe, returns that initialized slice directly when possible, and retains bounded growth checks. Empty files, binary bytes, chunk boundaries and the configured maximum are tested. This preserves the existing trusted-only filesystem semantics.

Allocation diagnostics compare the previous main commit with the new adapter in isolated child processes. Instrumented allocation counts are diagnostic quantities, not claims about peak physical RAM. Lifecycle performance runs have no allocation instrumentation or forced GC.

## Results

All 24 comparison runs passed: three serial trials for each of eight configurations, with rotated order. Each trial executes seven representative turns / 35 real tool calls, starting with approximately 100 KiB of history and ending with 108 messages. All processes exit naturally; the harness finds no surviving children. Two additional followups pass, including 21 fresh processes / 105 tools ending with 276 messages, 21 reports and 252 transcript events.

The table uses medians of per-trial statistics. **Warm turn** measures the core turn itself; **subsequent process** includes fresh-process startup, checkpoint loading, the turn and normal exit. Resident processes also include 1.5 seconds of idle observation per trial, and all turns include 420 ms of scripted inference delay. Idle zero means no remaining core process, not zero gateway/server memory or zero kernel page cache.

| Backend / mode | Idle core PSS MiB | Warm turn ms | Subsequent process ms | CPU / 7 turns s | Sampled peak PSS range MiB |
|---|---:|---:|---:|---:|---:|
| direct / resident | 237.3 | 641 | — | 3.35 | 650–691 |
| direct / request | 0.0 | 1218 | 1811 | 13.07 | 691–694 |
| direct / request-cache | 0.0 | 1229 | 1552 | 11.93 | 691–698 |
| sdk / resident | 232.7 | 569 | — | 2.48 | 613–689 |
| sdk / request | 0.0 | 733 | 1649 | 11.04 | 661–678 |
| sdk / request-cache | 0.0 | 723 | 1446 | 9.60 | 642–669 |
| sdk-upstream / resident | 232.2 | 578 | — | 2.77 | 638–693 |
| sdk-upstream / request-cache | 0.0 | 726 | 1403 | 9.58 | 643–693 |

For the native SDK, compile caching reduces median subsequent process time from 1.649 s to 1.446 s (12%) and median seven-turn CPU from 11.04 s to 9.60 s (13%). Compared with retaining the SDK process, per-request cached execution uses about 3.9 times the CPU over seven turns. It removes roughly 233 MiB of observed idle core PSS but does **not** reduce startup peaks. These short seven-turn idle observations are not directly comparable with older 21-turn retained-heap results.

`sdk-upstream` keeps the same SDK filesystem and sandbox tool route while substituting OpenClaw's original process supervisor. Its resident CPU is 2.77 s versus 2.48 s with the SDK supervisor, and cached-request CPU is essentially equal. This control suggests the native supervisor alone does not explain the direct-versus-SDK gap. Different host/sandbox coding-tool wrappers and path preparation remain confounders. No claim of full direct-Node feature parity follows from the timing result.

**Outlier retained:** SDK request trial 1612 takes 40.99 s / 38.28 s CPU for its first process, almost entirely before `worker-ready`. Its longest sampling gap is 8.69 s, so its sampled peak is particularly unreliable. The cause is not isolated. That trial's seven-turn total is 47.48 s CPU; it remains in all original ranges and median calculations. The explicit followup (1624) completes with 10.71 s CPU and a 1.658 s first process and is not substituted into the original three trials. Cold-start tail latency remains unresolved.

The 21-request cached followup takes 31.25 s total process time / 29.52 s CPU; subsequent process median is 1.472 s and sampled peak is 688 MiB. It establishes continuity at the previous workload's history scale, not a production capacity limit.

Allocation diagnostic medians (per read, three rotated trials per version):

| File size | Previous explicit buffer bytes | New explicit buffer bytes | Previous final-copy bytes | New final-copy bytes | CPU change |
|---|---:|---:|---:|---:|---:|
| 4 KiB | 131,072 | 4,098 | 4,096 | 0 | −10% |
| 64 KiB | 131,072 | 65,538 | 65,536 | 0 | −17% |
| 1 MiB | 1,048,577 | 1,048,578 | 1,048,576 | 0 | −39% |

Explicit buffer counts exclude the separately listed concatenation copy; they are not a whole-Node allocation census. CPU improvements are from an instrumented filesystem microbenchmark and cannot be applied as percentages to the whole core.

Validation: 48 SDK tests pass (including one test documenting the known upstream EOF failure), three checkpoint tests pass, real OpenClaw SDK and upstream-supervisor probes pass, and the modified shared representative fixture also passes a three-turn run on the original agentOS guest. The original protected-host validation remains unchanged and blocked.

Raw reports and source hashes: `artifacts/results/request-lifecycle-summary.json`, `lifecycle-*.json`, `file-read-allocation.json`, `request-*-tests.txt`, the OpenClaw probes, and `benchmark-1vm-1640.json`. Trials 1600–1602 and 1620 are exploratory/smoke runs, excluded from the comparison summary; 1600 records the corrected initial benchmark-builder substitution failure.

Final review also hardened corrupt-checkpoint handling for valid JSON primitives (including null); those cases are tested. The exact helper source used in the performance trials is retained in `request-checkpoint-measured-source.json`. This validation-only followup does not change successful checkpoint execution; a final three-process smoke run validates the shipped helper.

## Reproduction

```sh
npm run bench:build
node scripts/benchmark/build-supervisor-control.mjs
npm run test:sdk
node --test test/request-state.test.mjs
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 1700
node scripts/benchmark/file-read-allocation.mjs
```

Each output trial must have a new number. Modes are resident, request and request-cache; backends are direct, sdk and sdk-upstream. The compile cache begins empty for each trial, so its first process includes cache population. No prepared V8 heap snapshot is used.

## Measurement limits and remaining work

All requests use trusted processes and Node filesystem access. Landlock/cgroup host acceptance is still blocked and production Linux sandbox mode stays disabled. The benchmark excludes the gateway and external Python controller, uses 420 ms of synthetic inference delay per turn, and reports process-tree PSS rather than whole-machine memory. Forty-millisecond sampling can miss short peaks. Repeated requests still load/initialize the core and compile the shell parser; compile caching cannot eliminate those costs.

The original direct baseline and native SDK route use different supervisors and different host/sandbox coding-tool adapters. Their headline difference alone does not prove that the SDK is intrinsically more efficient. The resident-versus-request comparison within each backend is the stronger lifecycle evidence. The sdk-upstream control isolates the supervisor difference while retaining those coding-tool adapter differences.

Next work should target cold module initialization and shell-parser startup, extend compatibility with actual skills/packages, and validate request recovery policy. A general inference/IPC request service and tenant scheduling remain separate work.
