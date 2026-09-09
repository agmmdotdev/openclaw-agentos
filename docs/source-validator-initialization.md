# Source-owned validator initialization

PR #23 is merged at `e743815acf5a56e43e03650043871ce0e9bae054`. This follow-up changes three TypeScript runtime owners under `packages/openclaw-core/upstream/`. The default runtime remains unchanged.

## Runtime changes

The model registry previously constructed its private catalog schema and compiled its validator during import. `createModelsConfigSchema()` now runs at the existing `loadCustomModels` validation boundary, after input parsing. In-memory worker registries do not pay that cost. File-backed and captured plugin catalogs retain the same schema, normalization, validation errors, and process-local validator reuse.

The interactive theme owner similarly constructs and compiles its private schema inside `parseThemeJson` on first demand. Language lookup and headless styling helpers no longer construct a theme-file validator. Theme-file parsing, missing-token errors, variable resolution, color output, and the shared theme proxy retain their existing behavior.

Computer-use contract import previously compiled five validators eagerly. Five private guards now compile independently on their first parse. The exported `compileComputerUseValidator` helper remains eager. Because the schema objects are exported, the private guards capture TypeBox-preserving schema snapshots immediately: mutating an exported schema cannot weaken the canonical parser before first demand. No wire schema, accepted action, field bound, result projection, or error text changes.

This is a source logic change, with no generated-bundle patch or new runtime configuration. Production source grows by 27 lines after the schema moves; the growth supplies two private factory/cache boundaries and snapshot-preserving lazy computer guards. Tests, diagnostics, benchmark tooling, and evidence are separate.

## Diagnosis and behavior proof

Fresh cached-request CPU profiles and unminified module observations selected these owners. The observed exclusive import work moved from about 38.2 to 13.3 ms for computer-use contracts, 18.6 to 0.1 ms for model-registry initialization, and 9.9 to 0.2 ms for theme initialization. These are single instrumented observations, not end-to-end performance estimates. V8 profiles retain explicit unmapped frames; source-map frame starts are not per-line attribution.

The computer demand test failed before the source change: five compilers ran during import when zero were expected. The private-model/theme test likewise failed before the change, observing 13 model schema objects plus one compiler and three theme schema objects plus one compiler. Both now stay idle on the corresponding helper-only paths and initialize once at first validation.

Validation covers 37 focused tests per build layout (25 runtime and 12 source tests), plus eight benchmark-provenance tests: 82 passing checks. Both standard and minified source builds pass. The source suites execute 64 real core tool calls per layout, including checkpoint continuation, background process input/poll/kill, filesystem read/write/edit/patch, and six diagnostic request processes overall. Those diagnostic requests execute 30 tools while all seven targeted validators remain undemanded. Custom-model parsing, normalization, errors and refresh, theme-file parsing and ANSI output, computer wire limits, result projection, and exported-schema mutation have focused coverage.

Eight separate diagnostic profiling turns execute another 40 tools. Profiling and module observation finish before accepted benchmark trials begin. Full upstream type checking, live providers, a live computer desktop, and a new automated-review pass are not claimed; the documented source-migration review waiver still applies.

## Frozen request comparison

Three rotating seven-turn groups compare previous source, updated source and the artifact control inside one copied dependency snapshot. Each trial starts with an empty Node compile cache. They use the same Node 24.19.0 request launcher, two-CPU affinity, 40 ms process-tree PSS sampling and 420 ms scripted inference per turn, with real tools. Copying and hashing are outside measured workers and warm the OS page cache. OS libraries and child executables are shared, not copied. No builds, tests or profiles overlap these trials.

| Metric | Previous source | Updated source | Artifact control |
|---|---:|---:|---:|
| CPU / seven turns | 22.60 s | 21.98 s | 21.64 s |
| Cached request latency | 3,218 ms | 3,130 ms | 3,102 ms |
| Cached-process peak PSS | 160.17 MiB | 155.73 MiB | 174.28 MiB |
| Whole-trial peak PSS | 209.49 MiB | 207.82 MiB | 216.50 MiB |

Compared with the previous source, total CPU falls **2.8%**, cached latency **2.7%**, and cached-process peak PSS **2.8%**. Cached-process CPU falls 3.6%. These are medians of per-trial statistics, with all three trials included; ranges overlap and individual pairs reverse some timing results. They do not establish production tail behavior or a universal speedup.

Against the fresh artifact control, the updated source uses **1.6% more CPU** and has **0.9% higher cached latency**, with **10.6% lower cached-process peak PSS**. The default remains unchanged. Source size is effectively unchanged: the minified index moves from 12,304,242 to 12,304,280 bytes.

Request trials: **63 turns and 315 real tools**, all valid. The maximum request process wall time is 4.40 seconds, in the cold baseline request; historical isolated stalls remain unresolved. Detailed medians, ranges, archive hashes and frozen provenance are in `artifacts/results/source-validator-request-summary.json`.

## Frozen resident comparison

| Metric | Previous source | Updated source | Artifact control |
|---|---:|---:|---:|
| CPU / seven turns | 7.57 s | 7.68 s | 7.41 s |
| Warm turn latency | 991 ms | 1,000 ms | 1,009 ms |
| Resident idle PSS | 207.63 MiB | 206.87 MiB | 214.33 MiB |
| Peak PSS | 218.45 MiB | 217.82 MiB | 224.88 MiB |

Resident CPU changes by **+1.4%**, warm-turn latency by **+0.9%**, and idle PSS by **-0.4%** versus the previous source. These mixed results do not establish a general resident speedup. The complete ranges and reference comparisons are in `artifacts/results/source-validator-resident-summary.json`.

Across both benchmark modes, **126 turns and 630 real tool calls pass**, with correct transcripts/files/checkpoints, normal exits, and no surviving workload descendants. All 18 planned reports are retained; no trial was discarded. Both summaries use snapshot manifest SHA-256 `1879e151cfd57f8e597d9a4130a418af6eed0e8cef38287be2650c7b808fdd9e`, covering 64,740 inventory entries. The complete inventory is `source-validator-snapshot-26090790.json.gz`. Its source commit identifies the baseline checkout; the captured runtime hashes and `source-validator-validation.json` identify the candidate build and source files.

## Reproduction and retained evidence

```sh
npm run sdk:build
npm run source-core:build
npm run source-core:build:minified
npm run test:source-runtime
npm run test:source-core
CORE_MINIFY=1 npm run test:source-runtime
npm run test:source-core:minified
python3 test/benchmark-snapshot.test.py
```

Build the baseline at the PR #23 merge commit using the same installed dependencies. Preserve its minified index and tool-runtime bundles plus manifests under `baseline-minified-*` filenames. Preserve its benchmark fixture under `baseline-minified-source-native-sdk-core-benchmark.mjs`, changing only its two imports to the preserved index and tool runtime. Build the candidate afterward. The baseline and candidate SDK tool-runtime bundles are byte-identical in this pass.

```sh
python3 scripts/benchmark/benchmark_snapshot.py \
  --output /tmp/openclaw-source-snapshot-NEW_ID --include-baseline-minified
```

The snapshot captures all three source layouts and the artifact control with the same copied dependencies, parser assets, SDK, harness and launchers. Missing baseline inputs or stale bundle manifests fail snapshot creation. The harness rejects uncaptured layouts. The initialization summarizer requires identical frozen provenance, matched conditions, stable variant hashes and distinct before/after source bundles. Existing default two-layout snapshot creation still works.

Use `source-validator-run-plan.json` for the exact accepted trial commands and rotating order. Choose fresh IDs and a new snapshot root when reproducing. `summarize-source-initialization.py --before-trials ... --after-trials ... --mode request-cache` and `--mode resident` produce the two summaries. Raw reports, the full snapshot inventory, demand observations, module observations and CPU profiles are retained under `artifacts/results/`.

## Scope and remaining work

Computer-enabled use pays compilation at first parse and retains private schema snapshots; the headless benchmarks do not establish its latency or memory performance. The pinned TypeBox compiler chooses acceleration/settings when compilation occurs. Owned runtime source does not change those settings; callers changing global TypeBox compiler settings between import and first parse are outside this proof.

Terminal/ANSI and `pi-tui` initialization remain in the refreshed profiles. Theme deferral alone cannot remove them: read/write/bash tool definitions independently import renderers. A later change must separate rendering ownership across those consumers and preserve interactive behavior. Plugin SDK alias initialization and generated metadata remain other profile candidates. Historical isolated startup stalls remain unresolved.
