# Defer native-core highlighting and root schema construction

This continues the native-core work after PR #13, based on main `ab51410`.
The reduced native artifact now defers two expensive initializations until their
first use. Three matched trials show **8.5% less CPU per seven cached requests**,
**5.1% lower subsequent-process latency**, and approximately **11 MiB less
resident idle PSS**. The libraries and configuration validation remain present.

## Implementation

`scripts/defer-native-core-init.mjs` applies a small, checked transformation to
the already pinned OpenClaw 2026.8.1 native artifact:

- Highlight.js previously registered every bundled language during module
  evaluation. The runtime registration now stores a private loader sentinel.
  Its existing synchronous getter resolves and caches the original library
  object on first access. Explicit runtime replacement and clearing still work.
  There is no replacement highlighter, reduced language list or proxy object.
- The root `OpenClawSchema` previously initialized through `init_validation_core`.
  Its original initializer now runs at entry to `validateConfigObjectRaw`, the
  only consumer of that schema in the sliced artifact. All schema definitions,
  refinements, validation results and error handling remain intact.
- Zod's default locale registration remains eager. It is a global side effect,
  so deferring it with the schema would change errors and could overwrite a
  custom locale installed before the first validation. The differential test
  covers both the default errors and preservation of a later custom locale.

The patch checks AST identifier-reference counts and exact text boundaries.
Additional consumers, changed loader structure or a new upstream worker hash
fail the build for review. The patch is intentionally specific to this pinned
artifact; it is not a general JavaScript lazy-initialization transform.

The reduced native build defaults to lazy initialization. Set
`NATIVE_CORE_INIT=eager` when building to retain the original behavior. Full
profile builds remain eager. The generated agentOS guest worker is byte-for-byte
unchanged, and `eager-native-core.mjs` matches the previous native core exactly.
Both native benchmark variants are generated with the same SDK setup and fixture.
The build manifest records the policy, boundary hashes and both core hashes.

This defers construction, not source parsing. The native entry remains roughly
14 MiB. Work that needs highlighting or full configuration validation still pays
the corresponding construction cost on first use.

## Matched lifecycle results

Trials 1860–1863, 1870–1873 and 1880–1883 run serially with alternating eager/lazy
order. There are three trials per configuration, seven turns / 35 real tool calls
per trial. Both variants use PR #13's baseline-Wasm request profile, the same two
allowed CPUs, 8 MiB semi-space cap, compact allocator, SDK, fixtures and assets.
Each request-cache trial begins with an empty JavaScript compilation cache.

| Native SDK mode | Initialization | Peak PSS range MiB | Idle core PSS MiB | CPU / 7 turns s | Subsequent process median ms |
|---|---|---:|---:|---:|---:|
| Request + compile cache | Eager | 232–239 | 0 | 8.17 | 1,377 |
| Request + compile cache | Lazy | 217–222 | 0 | 7.47 | 1,307 |
| Resident | Eager | 243–247 | 235.2 | 2.45 | — |
| Resident | Lazy | 232–235 | 224.0 | 2.32 | — |

Values are medians of per-trial summaries, except the peak ranges. Median
request peak PSS falls from 233.4 to 217.7 MiB (6.7%). Seven-request CPU falls
8.5%, subsequent process latency 5.1%, and resident idle PSS 4.7%. Resident warm
turn medians are 596 versus 576 ms, but their per-trial ranges overlap; that is
not strong evidence of a general warm-execution speedup.

All 12 comparison trials pass: 420 real read/edit/write/exec calls, exact
workspace/history assertions, normal exit, and no surviving descendants.
The separate 21-process lazy followup (1894) passes another 105 tool calls and
preserves 276 messages, 21 reports and 252 transcript events. Its sampled peak
is 218.7 MiB, subsequent process median 1.319 seconds, and total CPU 22.02 seconds.
This followup is not substituted into the matched seven-turn comparison.

Every turn includes 420 ms of scripted inference. Resident runs include 1.5
seconds of idle observation. The external Python controller is excluded;
40 ms sampling may miss short peaks. Zero idle core PSS means the processes
have exited, not that a gateway, OS or cache consumes no memory. No production
capacity estimate or protected-execution performance claim follows from this.

## First-use cost and parser throughput

Instrumented initializer traces show the intended deferral. Neither the
highlighter registration nor the root schema initializer runs during lazy
embedded initialization. A paired demand diagnostic under the request profile
records:

| Instrumented phase | Eager ms | Lazy ms |
|---|---:|---:|
| Eager module evaluation | 96.9 | 50.5 |
| Embedded initialization | 202.9 | 168.2 |
| First configuration validation | 3.5 | 26.8 |
| First highlighting operation | 9.5 | 39.7 |
| Second configuration validation | 0.2 | 0.3 |
| Second highlighting operation | 0.3 | 0.3 |

These single paired diagnostics include instrumentation and are not performance
comparison statistics. They demonstrate where work moves. Applications that use
both deferred features immediately should expect much smaller startup savings.

A separate test quantifies PR #13's Wasm compiler tradeoff, holding this lazy
JavaScript core constant. After 100 warmup parses and a one-second pause, each
trial parses 1,000 commands across five scripts, including a repeated 100-line
loop script. Three serial rotated trials produce:

| Parser compiler profile | Warm parse wall time ms | Warm parse CPU ms |
|---|---:|---:|
| Normal optimizing Wasm | 265.6 | 277.3 |
| Baseline-only Wasm request profile | 409.4 | 418.0 |

Baseline-only Wasm takes **54% more warm parsing time** and about **51% more
warm parsing CPU** in this deliberately parser-heavy workload. All 6,000 measured
parses pass their checks with identical aggregate structure counts. This is a
tradeoff from the previous opt-in Wasm profile, not a regression caused by lazy
JavaScript initialization. The request profile saves transient compiler RAM and
short-request CPU; a long-lived, parser-heavy core may benefit from normal Wasm
optimization. The existing Node memory launcher retains that normal compiler.
This microbenchmark measures the warm parse loop, not complete core requests.

## Compatibility evidence

- The native-core differential runs the actual eager and lazy implementations in
  separate processes. Sixteen configuration inputs produce identical serialized
  validation results, including valid input, unknown fields, invalid types and
  invalid nested settings. Default and custom locale behavior match.
- The complete registered-language list and highlighting results for 15 languages
  match. Auto-detection, custom language registration/aliases/removal, object
  identity, explicit runtime replacement and clearing are checked. Counters
  verify that deferred initialization occurs once on demand.
- The patch rejects an added root-schema consumer and a changed getter boundary.
- All **50 SDK tests** pass. The two new tests use installed Zod 4.4.3, YAML 2.9.0,
  Ajv 8.20.0, minimatch 10.2.6, Undici 8.10.0 and AWS S3 client 3.1125.0 through
  the native JavaScript API. An ESM workflow reads YAML, validates data, matches
  filenames, writes a report, exercises HTTP serialization and signs/deserializes
  an S3 request. Its output matches direct Node. CommonJS entry points also pass.
- Package tests use the pinned OpenClaw dependency closure. HTTP and S3 transports
  are mocked; they do not verify live provider access, IAM, network policy or
  package installation. A skill-style Node workflow is not proof of OpenClaw's
  complete skill-discovery or extension-loading system.
- Both real OpenClaw tool probes pass: native SDK and the original agentOS-tool
  hybrid through its existing memory launcher. The 19-case parser differential,
  three checkpoint tests, TypeScript checking and 11 existing unit tests pass.

This work does not enable Linux sandbox enforcement. The trusted-only boundary,
unsupported broader SDK APIs and the historical 41-second startup outlier remain
as previously documented.

## Reproduce

```sh
npm run core:build
npm run bench:build
npm run test:native-lazy-init
npm run test:sdk
npm run test:native-sdk:request
npm run test:parser-startup
npm run test:request-state
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 1900 --profile request --initialization eager
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 1901 --profile request
# Repeat serially in alternating order; use --mode resident for resident trials.
node scripts/diagnostics/profile-native-startup.mjs 1910 --eager --deferred-use
node scripts/diagnostics/profile-native-startup.mjs 1911 --deferred-use
node scripts/benchmark/parser-throughput.mjs 1912
```

Use unused trial numbers. Diagnostics and benchmarks run separately. The raw
reports, summary, tests and initializer traces are in `artifacts/results`.
`scripts/benchmark/summarize-lazy-init.py --trials ...` verifies matching build
inputs and summarizes three trials for each mode/initialization combination.

The next startup target is the remaining source-loading/compilation cost and
other eager schemas. Moving unused highlighter code into a separately loaded
artifact could reduce parsing as well as construction, but requires another
checked dependency boundary and matched compatibility evidence.
