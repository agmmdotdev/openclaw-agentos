# Source-owned terminal initialization

PR #24 merged at `8c5a633a62f1251871e1f3651ea1e1cc336ca874`. This follow-up changes the rendering demand boundary in owned TypeScript source. The default remains the artifact runtime.

## Runtime ownership

Seven session tools (read, write, edit, bash, grep, find and ls), their rendering helpers, keybinding hints, visual truncation and theme loading previously imported `pi-tui` eagerly. Headless tool construction therefore initialized the terminal dependency even when no renderer was called. The headless `wrapToolDefinition` owner copies execution fields and excludes rendering hooks, so the eager imports had no role in executing those requests.

`getTerminalRuntime()` now synchronously loads the owned `terminal-rendering.runtime.ts` boundary when a renderer or terminal-dependent helper actually runs. That module re-exports only the nine needed dependency bindings. The literal require follows the existing bundled schema-loader pattern: esbuild supplies one cached initializer, and later interactive consumers share the same dependency constructors, keybindings and capabilities. Requiring the entire dependency directly retained extra unused exports; the narrow boundary preserves tree shaking.

The private bash/write renderer subclasses only held per-component state. They are replaced by typed composition on the existing dependency components, following the edit renderer's established pattern. This removes eager inheritance without adding a class cache or creating fresh subclasses per render. Synchronous callbacks, per-component state, ANSI text, output wrapping and tool execution are preserved. Constructor names of those two private subclasses disappear; they are not exported contracts.

Production source changes by **+34 lines** across thirteen files. The growth owns one synchronous demand boundary and its narrow exports; formatting accounts for part of it. Two private subclasses are removed. No execution algorithm, tool schema, prompt, runtime option, installed dependency or generated runtime bundle is patched.

## Before/after proof

The real three-request demand check failed before the source change: the terminal index and utility initializers each ran once, where zero were expected. It now performs fifteen actual filesystem/process tool calls with both counters at zero. Standard and minified checks cover six diagnostic request processes and thirty tools in total. Existing model/theme/computer-validator demand assertions also remain green.

A separate real bundled renderer test reads the eleven original owners from the pinned merge commit and compares them with the candidate against the same installed dependencies. It reproduces the original eager loading, then checks seven tools' synchronous components, exact ANSI/wrapped output at normal and narrow widths, expansion, errors, component reuse, incremental write highlighting, bash timer cleanup, asynchronous edit previews and compact skill reads. Dependency constructor identity and mutable keybinding/capability state stay shared. This is direct renderer execution; an attached interactive terminal session and screenshots are not claimed.

All **76 focused checks pass**: twenty-five runtime plus thirteen source checks in each layout. The suites perform **128 actual core tool calls** beyond the benchmark runs. Standard/minified source and SDK-tool-runtime builds pass; runtime bytes match their manifests. The SDK itself is unchanged in this pass. Full upstream type checking, formatter/lint gates, live providers, upstream CI and fresh automated review are not claimed. The existing source-migration automated-review waiver applies; an independent source review found no actionable regression in the changed boundary.

An unminified diagnostic copy observed thirty-eight `pi-tui` module callbacks during original import (15.5 ms summed exclusive work) and zero afterward. These single instrumented observations locate the work; they are not end-to-end performance estimates. Their exact input hashes and full observations are retained. Minified runtime size changes from 12,304,280 to 12,304,745 bytes (+465 bytes).

## Frozen request comparison

Three rotating seven-turn groups compare previous source, candidate and fresh artifact control in one copied dependency snapshot. All variants use Node 24.19.0, the same request launcher, two-CPU affinity, 40 ms process-tree PSS sampling, empty compile cache per trial, and 420 ms scripted inference per turn with actual tools. Copying and hashing are outside measured workers and warm the OS page cache. OS libraries and child executables remain shared. No build, test or profile overlaps accepted trials.

| Metric | Previous source | Candidate | Artifact control |
|---|---:|---:|---:|
| CPU / seven turns (s) | 7.43 | 7.23 | 7.02 |
| Cached latency (ms) | 1,328 | 1,312 | 1,249 |
| Cached-process peak PSS (MiB) | 151.93 | 150.00 | 172.84 |

Against previous source: total CPU **-2.7%**, cached latency **-1.3%**, cached-process peak PSS **-1.3%**. Against fresh artifact control: CPU **+3.1%**, cached latency **+5.0%**, cached peak PSS **-13.2%**.

## Frozen resident comparison

| Metric | Previous source | Candidate | Artifact control |
|---|---:|---:|---:|
| CPU / seven turns (s) | 2.44 | 2.33 | 2.45 |
| Warm latency (ms) | 585 | 583 | 594 |
| Idle PSS (MiB) | 206.67 | 206.03 | 214.61 |
| Peak PSS (MiB) | 216.47 | 215.96 | 224.27 |

Against previous source: CPU **-4.5%**, warm latency **-0.5%**, idle PSS **-0.3%**. These are medians of per-trial statistics, with ranges retained in the summaries. Small differences and overlapping ranges do not establish a universal speedup or production tail behavior.

Across both modes, **126 benchmark turns and 630 real tools pass**. All eighteen planned reports are retained; none is discarded. File/transcript/checkpoint continuity, parser availability, normal exits and descendant cleanup pass. Maximum request process wall time across variants is 1.73 seconds. Historical isolated startup stalls remain unresolved.

The snapshot covers 64,740 inventory entries; manifest SHA-256 is `485f199b8c1c623099961e83605e3c13adbdf50d9960b63ee364e07876fbdc70`. Its source commit identifies the baseline checkout. Candidate runtime manifests and owned source hashes are recorded separately in `source-terminal-validation.json`. The copied baseline/candidate SDK tool-runtime bundles are byte-identical.

## Reproduction

Build/preserve the PR #24 minified runtime and SDK tool-runtime bundles plus manifests as `baseline-minified-*`. Preserve its benchmark fixture as `baseline-minified-source-native-sdk-core-benchmark.mjs`, changing only its two runtime imports. Build the candidate with the same installed dependencies:

```sh
npm run source-core:build
npm run source-core:build:minified
npm run test:source-runtime
npm run test:source-core
CORE_MINIFY=1 npm run test:source-runtime
npm run test:source-core:minified
python3 scripts/benchmark/benchmark_snapshot.py --output /tmp/openclaw-source-snapshot-NEW_ID --include-baseline-minified
```

Use fresh trial IDs and the exact rotating commands in `artifacts/results/source-terminal-run-plan.json`. Summarize with `scripts/benchmark/summarize-source-initialization.py --before-trials ... --after-trials ... --mode request-cache` and `--mode resident`. Retained evidence includes both summaries, all eighteen compressed reports, the complete snapshot inventory, standard/minified demand results, module observations, four focused-test logs and validation hashes.

## Tradeoffs and follow-ups

The first terminal-dependent call now pays synchronous module initialization. The headless comparison does not establish interactive first-render latency. Chalk and the separate owned terminal-core ANSI module remain eager; this change does not claim to defer them. Direct unbundled TypeScript execution is outside this package's supported build contract.

Named compatibility follow-up: the existing write-result renderer can reuse a successful `Container` as an error `Text` and call missing `setText` on a success-to-error transition. This predates the demand change; current parity checks preserve ordinary same-kind reuse. Fix this at the write renderer's component owner with a transition regression test in the next compatibility pass.

Other source startup candidates remain the owned terminal-core ANSI initializer, SDK alias initialization and generated metadata. Reprofile before selecting a new optimization. Protected Linux enforcement still requires the unavailable host acceptance environment. The default remains unchanged.
