# Native highlighter module experiment

This follows PR #14's lazy initialization. It moves the original highlighter
declarations into a separately loaded file, so requests that never highlight text
also avoid loading and parsing that source. It is an **opt-in layout experiment**;
the default remains PR #14's bundled lazy core.

## Boundary and behavior

The pinned worker remains OpenClaw 2026.8.1. A TypeScript symbol graph finds the
complete dependency closure of its `require_lib$9` highlighter loader. The new
`scripts/split-native-highlight.mjs` extracts 195 declarations, preserving their
original text, order and all bang-style legal notices. The only duplicated
dependency is the exact, checked, stateless CommonJS wrapper helper.

The extraction rejects changed dependency counts, new external consumers, changed
helper text and non-wrapper declarations. The existing whole-worker SHA guard
still rejects unreviewed upstream artifacts. This is a pinned artifact transform,
not a general-purpose JavaScript bundler.

The existing synchronous getter loads `native-highlight.cjs` through Node's
`createRequire` on first use. That file exports a factory: each core receives its
own highlighter, even when Node shares the module cache between multiple cores.
Library identity within a core, language registration, runtime replacement and
explicit clearing retain their previous behavior. There is no replacement
highlighter or reduced language set. The root schema remains lazily initialized
as in PR #14. The Bash parser and its Wasm compilation policy are unchanged.

| Artifact | Bytes | MiB |
|---|---:|---:|
| Previous bundled lazy native entry | 14,597,719 | 13.92 |
| Split native entry | 13,517,520 | 12.89 |
| Separately loaded highlighter | 1,087,393 | 1.04 |

The entry shrinks **7.4%**. Total deployed JavaScript grows slightly because the
helper, legal notices and loader need to exist across two files. This is reduced
startup loading, not reduced total functionality or package footprint.

## Matched results and decision

Trials 1920–1925, 1930–1935 and 1940–1945 compare bundled-lazy and split-lazy
entries. There are three trials per layout/mode, seven turns per trial, with
serial execution and reversed layout order in the middle repetition. The SDK,
tool fixture, two allowed CPUs, compact allocator, 8 MiB semi-space cap and
PR #13's opt-in baseline-Wasm request profile are held constant. Each cached
trial starts with an empty compilation cache.
The runtime is Node 24.19.0 / V8 13.6.233.17-node.51 on Linux x64.

| Mode | Layout | CPU / 7 turns s | Subsequent process ms | Peak PSS MiB | Resident idle PSS MiB |
|---|---|---:|---:|---:|---:|
| Request + compile cache | Bundled | 7.40 | 1,284 | 223.5 | 0 |
| Request + compile cache | Split | 7.81 | 1,312 | 222.4 | 0 |
| Request without compile cache | Bundled | 8.99 | 1,585 | 224.7 | 0 |
| Request without compile cache | Split | 8.84 | 1,536 | 222.5 | 0 |
| Resident | Bundled | 2.36 | — | 232.4 | 223.6 |
| Resident | Split | 2.31 | — | 229.9 | 220.0 |

These are medians of per-trial summaries, including the per-trial maximum sampled
PSS. Resident idle PSS saves **3.6 MiB (1.6%)**; the bundled trial range is
223.08–223.65 MiB, versus 219.87–221.87 MiB split. Uncached request peak ranges
are 223.57–225.20 MiB bundled and 222.31–223.23 MiB split. Cached peak ranges
overlap substantially (218.32–224.81 versus 218.66–222.64 MiB).

The CPU/latency result is mixed. Cached CPU is **5.5% higher** and subsequent
process median **2.2% higher** with the split. Uncached CPU is 1.6% lower and
latency 3.1% lower, but CPU and latency trial ranges overlap. Resident CPU differs
by 1.8%, also with overlapping ranges. This does **not** establish a general
startup speedup. The small RAM saving does not justify changing the default.

All **18 trials pass**, with 630 real read/edit/write/exec calls and verified
files, persistent history, normal exits and no surviving descendants. Each turn
includes 420 ms of scripted inference; resident trials include 1.5 seconds of
idle observation. The external Python controller is excluded, and 40 ms PSS
sampling may miss short peaks. Zero idle core memory means the request process
has exited, not that the host, filesystem cache or gateway consumes no memory.

Trial 1931 contains a **5.689-second cached split request**, with 5.771 seconds
of process-tree CPU and its first `worker-ready` marker at 4.916 seconds. It is
retained in all summaries; its trial CPU is 12.27 seconds. Its cause is unresolved,
and this evidence neither proves a split regression nor explains the previously
documented 41-second startup outlier. It reinforces that startup tail latency
needs investigation before treating these averages as a capacity guarantee.

The measured entries are byte-identical to the final opt-in build. After seeing
the results, the builder's default was changed back to bundled and an explicit
split artifact was added for testing both layouts. Raw reports preserve their
original measured build hashes; `split-build-validation.json` records the final
build and verifies generated entry/control/highlighter/guest hashes against the
measured build. Performance trials were not rewritten to claim a different build.

## First-use diagnostic

Separate instrumented runs 1958 (bundled) and 1959 (split) exercise highlighting
after core/parser startup. Under the request profile, the first highlighting call
takes 40.8 ms bundled versus 103.4 ms split; the second takes 0.3 versus 0.4 ms.
Under normal Wasm optimization, the first calls take 41.8 versus 63.4 ms. These
are single diagnostics, not matched performance statistics, and the extracted
module's internal initializers are not individually instrumented. The enclosing
phase includes loading, parsing, compilation, construction and actual highlighting.
This confirms the practical first-use cost of moving source behind the getter.

## Compatibility

The three-way differential executes the eager, bundled-lazy and split-lazy real
cores in separate processes. It compares 16 configuration inputs, default and
custom Zod locale behavior, the complete registered language list, output for 15
languages, auto-detection, custom language aliases/removal, runtime replacement
and explicit clearing. Initialization counters and Node's module cache confirm
that the highlighter stays unloaded until demand and initializes once.

Additional checks cover two cores sharing one highlighter file without sharing
custom language state. A missing highlighter file permits startup that does not
use highlighting, then fails explicitly with `MODULE_NOT_FOUND` on demand.
Boundary mutations introducing consumers or changing the shared helper fail.

All five initialization/module tests pass. Six further tests pass for the real
Bash parser (19 cases), checkpoint recovery/interruption and six actual npm
packages through the native SDK. HTTP/S3 transports remain mocked. Both native
SDK and original agentOS hybrid real-tool probes pass. Core TypeScript builds
succeed with the default and opt-in layouts.

The next useful target is the intermittent CPU-heavy work before `worker-ready`.
Capture a startup CPU profile when that delay recurs, then target the measured
module or compiler path. Further source splitting without evidence risks adding
packaging and first-use costs for very small gains.

## Reproduce and packaging

```sh
NATIVE_CORE_LAYOUT=split npm run core:build
npm run bench:build
npm run test:native-lazy-init
npm run test:native-sdk:request
npm run test:hybrid:memory
node scripts/diagnostics/profile-native-startup.mjs 1962 --bundled --deferred-use
node scripts/diagnostics/profile-native-startup.mjs 1963 --deferred-use
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --profile request --initialization bundled --trial 1960
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --profile request --initialization current --trial 1961
```

Use unused trial numbers. Repeat serially in alternating order, also using
`--mode resident` and `--mode request`. `current` means the generated native entry;
build explicitly with `NATIVE_CORE_LAYOUT=split` for this comparison. `bundled`
selects the matched PR #14 lazy control, not the older eager core.

Keep `native-highlight.cjs` beside any split native entry, including generated
benchmark/probe entries. Moving the entry requires moving that file as well as
the pre-existing parser assets. Its SHA and byte count are in the build manifest,
and the benchmark builder validates its content. This hash check is a build
integrity check, not a runtime sandbox boundary.

Omitting `NATIVE_CORE_LAYOUT` retains the bundled layout. Setting it explicitly
to `bundled` also works. The split layout requires lazy initialization; eager and
full-profile builds remain bundled. The original agentOS guest worker is
byte-for-byte unchanged.

The native backend remains trusted-only, inference remains scripted, and Linux
sandbox enforcement is still unavailable here. These measurements do not include
a gateway, production model access or protected execution.
