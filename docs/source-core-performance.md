# Source-core migration: measured trade-offs

This report records the initial PR #19 comparison. The subsequent [source initialization pass](source-core-initialization.md) contains current measurements and validation.

PR #18 is merged. Keep the merged artifact runtime as the default: the source-owned core passes the focused behavior checks, but cached requests still cost more CPU and latency. Source ownership enables core changes; it does not itself guarantee a speedup.

## Matched request results

Each row compares three seven-turn source trials with three fresh control trials, in alternating order. Both paths use the same native SDK, representative workload, checkpoint handling, single-Node launcher, allocator settings, two-CPU affinity, and Node 24.19.0 request flags. Each trial starts with an empty compile cache. Inference is scripted with 420 ms of delay per turn; filesystem and process tools are real. External sampler memory is excluded.

| Source build | CPU / seven turns | Cached request latency | Cached-process peak PSS | Whole-trial peak PSS |
|---|---:|---:|---:|---:|
| Standard source | **+9.5%** | **+9.3%** | **+13.7%** | +2.1% |
| Minified source, function names preserved | **+8.5%** | **+7.3%** | **−3.9%** | +0.2% |

These are source-versus-control changes within each matched block. Do not subtract the two rows to claim a directly measured minification gain.

| Block / runtime | CPU / seven turns | Cached request median | Median cached-process peak PSS | Trial peak PSS |
|---|---:|---:|---:|---:|
| Standard block: control | 21.84 s | 3,094 ms | 175.1 MiB | 216.1 MiB |
| Standard source | 23.91 s | 3,382 ms | 199.1 MiB | 220.5 MiB |
| Minified block: control | 21.68 s | 3,089 ms | 174.5 MiB | 216.4 MiB |
| Minified source | 23.52 s | 3,314 ms | 167.8 MiB | 216.8 MiB |

Each statistic is the median of per-trial statistics. Cached request latency includes startup, checkpoint work, tool execution, and exit, excluding the first process in each trial. Cached-process peak PSS is the median of those six process peaks, then the median across trials. Trial peak PSS includes the cold first request, which obscures the difference between cached-process memory figures. PSS sampling is every 40 ms and can miss short peaks. Idle core memory after process exit is zero for both paths.

The minified runtime is 12,303,403 bytes versus 25,778,126 bytes for the standard source build, a 52.3% reduction. It uses esbuild's normal source compilation with `minify: true` and `keepNames: true`; it does not modify a compiled worker bundle. Both source layouts remain available for comparison.

## Resident checks

Two exploratory matched resident pairs each ran seven turns. In the standard pair, warm-turn medians were 1,012 ms (control) and 1,007 ms (source), with idle PSS 212.5 and 207.7 MiB. In the minified pair, they were 974 and 1,017 ms, with idle PSS 214.1 and 214.6 MiB. These are single pairs per layout, not enough to claim a resident optimization. The request regression is materially clearer than the resident difference.

## What the profiles suggest

One additional cached request per runtime was CPU-profiled after a priming request. These are diagnostics, excluded from the performance tables and not substitutes for matched CPU measurements. Child tool CPU is absent from these core-only profiles.

The minified source profile attributed about 791 ms of sampled intervals to anonymous core frames versus 274 ms in the control. Compilation-related samples were lower in the source profile, while garbage-collector samples were similar (194 versus 198 ms). This suggests module evaluation is a useful next investigation target; it does not prove one initializer caused the regression.

Source-map attribution leaves approximately 479 ms in unmapped anonymous generated frames. Named source locations include terminal/TUI utilities and ANSI handling. Do not treat these frame-start mappings as line-level cost attribution. The next experiment should instrument source module initialization and isolate headless tool dependencies from terminal formatting initialization, then remeasure the same workload.

Neither the prior 5.7-second nor 41-second request stall recurred in these uninstrumented request trials. Their cause remains unexplained.

## Validation and evidence

All 16 benchmark trials passed: **112 turns and 560 real tool calls**, with expected file contents, transcript continuity, checkpoint progression, normal exits, and no surviving workload descendants. Parser fallback errors are rejected by the comparison script. The four focused tests also passed on the minified build, including 28 exact configuration/locale comparisons, deferred once-only schema initialization, routing isolation/revocation, three request processes with 15 real tool calls, and highlighter demand/replacement behavior. Four additional turns with 20 tool calls completed while priming and recording the two CPU profiles.

The source benchmark now reuses the original fixture's request-completion, SQL calibration, and resident idle sequence. The lifecycle runner supports `sdk-source` and records the source artifact hash and build manifest. Both blocks retain the original control artifacts and fresh measurements from this session; absolute timings should not be compared with earlier days.

- Standard trials: IDs 26090700–26090702; resident pair 26090700.
- Minified trials: IDs 26090710–26090712; resident pair 26090710.
- Compressed raw results: `artifacts/results/lifecycle-*-260907*.json.gz`.
- Summaries with archive hashes: `artifacts/results/source-migration-standard-summary.json` and `source-migration-minified-summary.json`.
- Compressed profiles and mapped samples: `artifacts/results/source-migration-profiles/`.

The old dependency symlink pointed to an expired session directory. Locked root dependencies were restored before compiling the minified variant. The existing control and standard source artifacts were retained unchanged; their hashes are recorded in each report. No dependency lockfile was changed.

## Reproduce

After the build prerequisites documented in `packages/openclaw-core/README.md`:

```sh
npm run source-core:build:minified
npm run test:source-core:minified
python3 scripts/benchmark/compare-source-core.py --trials 26090700 26090701 26090702
python3 scripts/benchmark/compare-source-core.py --source-layout minified --trials 26090710 26090711 26090712
```

For new trials, choose unused trial IDs and alternate the order:

```sh
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --profile request --turns 7 --trial 26090720
python3 scripts/benchmark/request-lifecycle.py --backend sdk-source --source-layout minified --mode request-cache --profile request --turns 7 --trial 26090720
python3 scripts/diagnostics/profile-source-core.py --output artifacts/results/source-migration-profiles-new
```

Keep the default runtime unchanged until the source build closes the CPU/latency gap and remaining parity checks pass. No full-upstream type-check, live-provider compatibility, or sandbox-enforcement claim is made. The existing user authorization for manual review of this source migration remains in effect.
