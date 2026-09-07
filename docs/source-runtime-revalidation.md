# Source runtime revalidation after SDK compatibility work

PR #22 merged as `495650071c91f82ff90b1b286dea6daeebfad755`. This pass repairs the measurement boundary and remeasures the minified source runtime after the filesystem and process supervision changes. The workload and runtime code are unchanged in this pass.

## Why the benchmark changed

The earlier lifecycle harness hashed its entry and source bundle. Those entries also loaded the SDK, the tool-runtime bundle, checkpoint code, a benchmark adapter, parser WASM and external packages. Changes to those files could alter an ostensibly unchanged comparison. The old measurements remain historical observations, but their limited dependency checks are not sufficient for the default-switch decision.

`benchmark_snapshot.py` copies the selected runnable entries, SDK distribution, core runtime bundles/manifests, parser assets, checkpoint/adapter/launcher code, package metadata, lockfiles and both installed dependency trees into a separate root outside the checkout. Relative package-manager links remain internal. Absolute or escaping links and ancestor `node_modules` directories are rejected. Build-manifest hashes are checked against copied files.

The snapshot records file content hashes, file sizes/modes, directory membership, link targets, the Node executable hash and the source base commit. Full dependency inventories are verified before and after each trial; rebuildable runtime files are verified between requests. The current sampler/harness must match the captured copies. Source checkout changes cannot modify the copies. A changed captured input invalidates the comparison.

The measured workers use that root, clear `NODE_PATH`, and disable Node's global module search. Workspace, state and compile-cache directories remain fresh temporary directories outside the snapshot. Hashing and copying occur outside worker wall-time, CPU and PSS measurements. The snapshot is a trusted experiment input, not a sandbox or a copy of the host OS/toolchain.

`compare-source-core.py` now requires frozen provenance by default, one snapshot across the entire comparison, consistent entry hashes per variant, and matching harness/sampler/launcher and environment data. `--allow-legacy` is explicit access to historical unfrozen reports; it does not retroactively freeze them.

## Method

Three seven-turn pairs per mode compare the merged artifact core with the current minified source core. Order alternates control/source, source/control, control/source. Both use the same captured native SDK distribution, representative tool workload, checkpoint implementation, allocator, two-CPU affinity, Node 24.19.0 and single-start request launcher with baseline-only WASM compilation. The reference loads the standard tool-runtime entry; the candidate loads its minified equivalent. The artifact reference retains historical spawn-only injection while the source core binds the full supervisor. This compares complete runtime stacks for the selected workload, not one isolated code change.

Request-cache trials begin with an empty V8 compile cache. Resident trials keep one process for seven turns and observe idle PSS after the work. Inference is scripted at 420 ms per turn; tools are real. The Python controller/sampler is excluded. File reads by the verifier warm OS page cache, so the first request is compile-cache-cold, not a cold-storage benchmark. OS libraries and child tool executables are shared host dependencies and are not copied.

Two two-turn preflight runs check execution from the relocated snapshot and are excluded from comparison medians. Do not compare absolute timings with older sessions or attribute the cumulative difference to one compatibility change.

## Results and decision

Keep the default unchanged. The source runtime reduces memory in both modes, but request CPU and latency are still higher. These are current source-versus-reference differences, not gains caused by this benchmark change.

| Request-cache metric | Artifact reference | Minified source | Source change |
|---|---:|---:|---:|
| CPU across seven turns | 21.53 s | 22.34 s | +3.8% |
| Cached request latency | 3,089 ms | 3,142 ms | +1.7% |
| Cached request CPU | 3.00 s | 3.05 s | +1.8% |
| Cached-process peak PSS | 173.8 MiB | 159.2 MiB | −8.4% |
| Whole-trial peak PSS | 215.7 MiB | 208.7 MiB | −3.2% |
| First request CPU | 3.68 s | 3.86 s | +5.1% |
| First request latency | 3,772 ms | 3,897 ms | +3.3% |

Each value is the median of three per-trial statistics. Cached figures exclude the first process. Cached peak PSS is the median of six process peaks within each trial, then the median across trials. Total CPU ranges were 21.24–21.62 s for the reference and 22.14–22.46 s for source. Cached latency ranges were 3,055–3,103 ms and 3,125–3,229 ms. Sampling every 40 ms can miss brief peaks. Idle core memory after request exit remains zero for both.

| Resident metric | Artifact reference | Minified source | Source change |
|---|---:|---:|---:|
| CPU across seven turns | 7.27 s | 7.37 s | +1.4% |
| Warm turn latency | 1,005 ms | 980 ms | −2.5% |
| Idle core PSS | 214.9 MiB | 207.9 MiB | −3.3% |
| Peak PSS | 225.3 MiB | 218.1 MiB | −3.2% |

Resident timing is less consistent: the third source trial used 7.81 s CPU versus 7.06 s for its paired reference, and its warm latency was higher, unlike the first two pairs. Three pairs do not establish a general resident speedup. The idle-memory reduction held in every pair.

No historical multi-second startup stall recurred: the slowest measured request in the comparison was 4.11 s. This does not resolve the prior 5.7-second, 18-second or 41-second stalls. Aggregate timings do not identify which initializer causes the remaining CPU gap. Next: refresh source startup profiles, then change the responsible source modules; eager model/catalog, computer-use and terminal initialization remain investigation targets.

## Retained evidence

All 12 comparison trials passed: **84 turns and 420 real tool calls**. The two excluded preflights add four turns and 20 calls, for **88 turns and 440 calls** overall. Every trial passed tool counts, file/transcript/checkpoint continuity, normal exit and no surviving workload descendants. Both summaries reject parser fallback logs and inconsistent provenance. Five focused provenance tests passed after the final analysis changes; Python compilation and whitespace checks also passed.

- Request-cache and resident comparison trial IDs: 26090780–26090782; preflight ID: 26090779.
- Compressed raw reports: `artifacts/results/lifecycle-*-260907{79,80,81,82}.json.gz`.
- Summaries: `artifacts/results/source-runtime-frozen-request-summary.json` and `source-runtime-frozen-resident-summary.json`, with raw archive and summarizer hashes.
- Full copied-input inventory: `artifacts/results/source-runtime-snapshot-26090780.json.gz`. Its uncompressed manifest SHA-256 is `c4c3f5ecfb10319606825d28c5737510c569b33eb77ed42fb593e9d3201550ca`, matching every report. The inventory includes 64,735 entries (files, directories and links); dependency contents are reconstructed from the locked installs rather than committed as another dependency tree.

No build or test ran during accepted comparisons. No runtime source was modified for this pass. This is not a full-upstream typecheck, live-provider test, security-enforcement result, or new runtime optimization.

## Validation

Five focused provenance tests cover independent copies, runtime/package changes, new resolution candidates, escaping links, ancestor packages, stale build manifests, manifest tampering, existing destinations, and rejection of unfrozen/mixed reports. The source runtime itself retains PR #22's behavior validation; no fresh full-upstream or live-provider test claim is made.

## Reproduce

Build the SDK and source layouts, then refresh the reference fixtures before freezing:

```sh
npm run sdk:build
npm run source-core:build
npm run source-core:build:minified
node scripts/benchmark/build.mjs
python3 test/benchmark-snapshot.test.py
python3 scripts/benchmark/benchmark_snapshot.py --output /tmp/openclaw-frozen-inputs
python3 scripts/benchmark/request-lifecycle.py --snapshot /tmp/openclaw-frozen-inputs --backend sdk --mode request-cache --profile request --turns 7 --trial 12345
python3 scripts/benchmark/request-lifecycle.py --snapshot /tmp/openclaw-frozen-inputs --backend sdk-source --source-layout minified --mode request-cache --profile request --turns 7 --trial 12345
```

Use unused trial IDs, alternate order and repeat with `--mode resident`. The artifact build prerequisites remain required. Build/copy outside accepted comparisons and never edit an active snapshot. Summarize each mode with `compare-source-core.py --source-layout minified --mode MODE --trials IDS`.
