# Reduce configuration-schema allocations during native core startup

This follows draft PR #16 at `55961f0`. The native core now avoids two eager
paths into configuration schemas that this request workload does not use.
The real Zod schemas, validators and native tools remain present. This does not
explain or claim to fix the historical 5.689-second and 41-second startup stalls.

## Allocation diagnosis

The new `--startup-diagnostics allocations` mode starts V8's sampling heap
profiler in a Node preload and stops at `worker-ready`. It uses a 32 KiB sampling
interval and includes objects collected by both minor and major GC. Those flags
are necessary to observe temporary allocation churn rather than only retained
objects; see the [DevTools HeapProfiler protocol](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-startSampling).
Profiles are stored losslessly as gzip, with original-byte SHA-256 checks.
The summary attributes sampled sizes to library frames and their nearest
configuration-schema initializer ancestor. These are statistical JavaScript
allocation estimates, not live heap size, process RAM or all native allocation.
The diagnostic preload and profile serialization perturb execution; their
CPU/latency measurements are excluded from the performance comparison.

The initial three-process diagnostic (2100) estimates 91.5–97.9 MiB allocated
before readiness. Zod's schema-construction internals are the largest repeated
library allocation sites, with the core configuration schemas responsible for
11.6–12.8 MiB and the agent runtime configuration schemas for 10.3–12.2 MiB.
Node module compilation also allocates roughly 14 MiB in these profiles.

There were two independent startup paths into the agent runtime schemas:

1. `init_config_schema$1` constructs an unassigned channel schema using two
   local schemas which have no other consumers in the sliced artifact.
2. `init_validation_core` eagerly initializes the root-support schemas for its
   MCP server-name helper, which in turn initializes the agent runtime schemas.

Removing the first path alone (2101) did not eliminate those allocations:
the second path still constructed the schemas. This unsuccessful intermediate
experiment is retained in the raw results instead of presented as a saving.
Removing both paths (2102) reduces the estimate to 76.5–79.8 MiB, and the agent
runtime/root-support schema frames disappear from the startup allocation samples.
The sampling result identifies a mechanism; the uninstrumented trials below
measure its practical impact.

## Checked transformation and semantics

The change extends the native-only transformation of the hash-pinned OpenClaw
2026.8.1 worker. Exact initializer text and identifier-reference counts reject
changed boundaries or new consumers. The discarded channel schema construction
is removed while Zod, core-schema and validator initialization remain eager.
The root-support initialization moves from validation setup to the entry of
`collectMcpServerNameIssues`. Existing full-schema dependency edges also retain
initialization, so both direct helper calls and full configuration validation
still construct and use the original synchronous schemas.

Zod's default locale remains eager; later custom locale settings are preserved.
Agent runtime schema definitions, refinements and sensitive-field registration
are unchanged and execute on demand. This defers work for requests that do not
validate full configuration. Applications validating configuration on every
request still pay that construction cost; it is not eliminated from those paths.
No changes to SDK supervision, checkpoint recovery, the guest worker, the Wasm
compiler profile or the single-start launcher are part of this optimization.

The build emits `before-allocations-native-core.mjs` and its SDK benchmark entry
as controls. They match PR #16's bundled core and benchmark entry byte-for-byte.
The default native layout remains bundled; highlighter splitting stays opt-in.

## Matched uninstrumented results

Trials 2130–2133, 2140–2143 and 2150–2153 run serially. Each round
runs request-cache then resident for one initialization and then the other;
the middle round reverses initialization order. There are three trials per
configuration, seven turns / 35 real tool calls each. Both variants use the
same bundled layout, two CPUs, Node 24.19.0, single-start launcher, allocator,
8 MiB semi-space cap and baseline-only Wasm profile. Compile caches begin empty
for each cached trial. No allocation profiler, GC observer or phase markers
run in these performance trials.

| Metric (median of per-trial summaries) | PR #16 control | Allocation pass | Change |
|---|---:|---:|---:|
| Cached request CPU / 7 turns | 22.49 s | 21.27 s | −5.4% |
| Subsequent process latency | 3,158 ms | 3,058 ms | −3.2% |
| Cached request sampled peak PSS | 224.5 MiB | 215.1 MiB | −4.2% |
| Request idle core memory after exit | 0 | 0 | unchanged |
| Resident idle PSS | 223.0 MiB | 214.5 MiB | −8.5 MiB |
| Resident CPU / 7 turns | 7.32 s | 7.13 s | −2.6% |

Cached CPU ranges are 22.10–22.75 s versus 21.16–21.95 s. Subsequent-process
median ranges are 3,074–3,173 ms versus 3,016–3,106 ms. Request peak ranges
are 223.7–226.4 MiB versus 214.5–215.9 MiB. Cached CPU, per-trial median latency
and peak PSS improve in all three pairs, although latency ranges overlap.
Resident idle PSS ranges are 222.8–223.2 MiB versus 212.1–214.7 MiB.
Warm resident tool-turn medians overlap; this is not evidence of a general
steady-state execution speedup.

All 12 trials pass: 84 turns / 420 real tool calls, exact checkpoint/history
and workspace contents, normal exits and no surviving descendants. There are
48 core processes: 42 fresh request processes plus six resident processes.
The external Python sampler is excluded; sampling every 40 ms can miss short
peaks. Each turn includes 420 ms of scripted inference. This is a trusted local
workload, not live provider inference or a production capacity estimate. Fresh
controls are used throughout; percentages must not be chained onto older runs
from a different session.

## First use and GC observations

A separate instrumented pair (2160/2161) keeps all schemas available and invokes
configuration validation and highlighting after startup. Under the request
profile, embedded initialization measures 414.8 ms before and 338.3 ms after;
first configuration validation measures 66.7 ms before and 155.7 ms after.
Second validation remains below 0.5 ms. First highlighting remains about 84–88 ms.
These single instrumented samples show where the work moves; they are not a
statistically established performance comparison. The new request measurements
must not be generalized to requests that always demand full config validation.

Two separate phase-only seven-request diagnostics (2170/2171) report warm startup
GC-count medians of 15 versus 12 and observed GC-duration medians of 127.6 ms
versus 105.0 ms. GC durations are clipped to the interval from preload to
`worker-ready`. Embedded-init medians are 482.9 versus 421.6 ms. This supports
the allocation mechanism, but one diagnostic per variant does not establish a
GC latency guarantee. These runs use no heap allocation sampler and remain
excluded from the uninstrumented results. Neither reproduces the historical
multi-second stalls. The observer is not a complete native allocation/GC trace.

## Compatibility and validation

The differential executes the actual eager, PR #16 control, current bundled,
and current split cores in separate processes. It compares 28 configuration
inputs, direct MCP-name checks (including `__proto__`, empty and whitespace
names), default/custom locale behavior, all registered highlighting languages,
15 language outputs, runtime replacement and per-core highlighter identity.
Both MCP-first and full-config-first orderings pass. Counters verify that the
agent-runtime and root-support schemas remain uninitialized before demand and
initialize exactly once afterward. Valid agent skill configuration is accepted;
conflicting agent tool policy is rejected. Changed consumers and construction
boundaries cause the transformation to fail closed.

Thirteen focused tests pass across lazy/highlighter behavior (six), launcher
behavior (three), the 19-case parser differential (one) and checkpoint handling
(three). The native SDK real-tool probe also passes. The final schema differential
was repeated after extending the agent-entry cases. No full gateway, channel,
protected Linux sandbox or live-provider acceptance is implied by these tests.

A full rebuild reproduces every tested generated artifact byte-for-byte,
including the unchanged guest worker and the exact PR #16 control entries.
`allocation-build-provenance.json` records the hashes. The benchmark fixture,
SDK code, launcher and measured core are identical across each comparison pair,
except for the intended native-core transformation. The harness later gained
an archive-existence guard; it changes result-file collision handling only and
is exercised by the final continuity run. Archived trial-number reuse is rejected.

The 21-process followup (2180) passes 105 real tools and preserves 276 messages,
21 reports and 252 transcript events. Its subsequent-process median is 3.196 s
and sampled peak PSS 215.4 MiB; it is a continuity check, not another matched
performance comparison. Across allocation diagnostics, phase diagnostics,
comparisons and this followup, all **128 turns / 640 real tool calls** pass in
92 core processes. The native SDK probe is additional to that tool-call count.

Raw lifecycle and first-use reports, plus all nine heap profiles, are archived
losslessly as gzip. Summary scripts accept either plain or compressed lifecycle
reports. Generated-entry and raw-profile hashes are retained; old diagnostic
entries can be regenerated from their corresponding revision/build and checked
against those hashes. The 2101 intermediate experiment removed only the discarded
channel schema, without the two root-support replacements present in the final
transformation.

## Reproduction

```sh
npm run core:build
npm run bench:build
npm run test:native-lazy-init
npm run test:request-launcher
npm run test:parser-startup
npm run test:request-state
npm run test:native-sdk:request

# Separate allocation diagnostics. Use unused trial numbers.
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 3 --trial 2200 --profile request --initialization before-allocations --startup-diagnostics allocations
python3 scripts/diagnostics/summarize-startup-allocations.py 2200
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 3 --trial 2201 --profile request --startup-diagnostics allocations
python3 scripts/diagnostics/summarize-startup-allocations.py 2201

# Performance runs have no profiler or phase instrumentation.
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 2210 --profile request --initialization before-allocations
python3 scripts/benchmark/request-lifecycle.py --backend sdk --mode request-cache --turns 7 --trial 2211 --profile request
# Repeat three pairs with alternating order; repeat for --mode resident.
# summarize-allocation-pass.py --trials accepts those 12 distinct trials.

# Instrumented first-use diagnostics, not benchmark results.
node scripts/diagnostics/profile-native-startup.mjs 2220 --before-allocations --deferred-use
node scripts/diagnostics/profile-native-startup.mjs 2221 --bundled --deferred-use
```

The next allocation target is the remaining eager core configuration schemas
and their dependency paths. That needs another checked consumer analysis; a
blanket removal of schema initialization would change behavior. Module loading
and compilation remain significant. Tail-latency diagnosis still requires
capturing an actual slow event before assigning a cause.
