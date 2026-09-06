# Native Node SDK extraction and measurements

Status: implemented trusted-only SDK slice; Linux enforcement remains unavailable
and unimplemented. Recorded 2026-09-06. Package and detailed API semantics:
[`packages/agentos-sdk`](../packages/agentos-sdk/README.md).

## What changed

The npm release's `gitHead` maps SDK 0.2.19 to upstream commit
`9ae6abbdc48391a75b8336e7832b3e76f42616ee`. A source checkout verified that mapping.
Execution types, selected public namespace signatures, and supporting filesystem
types are extracted with Apache-2.0 license/provenance. New native backend code
implements these contracts; a factory can also lazily select the original SDK.
This is a partial SDK extraction, not a complete port of the upstream class.

The native entrypoint has no npm runtime dependencies or sidecar. It implements
filesystem operations, native process/JavaScript execution, streams, stdin,
timeout/cancellation, bounded replay/history, and disposal preserving files.
The native OpenClaw adapter routes original tools through this package using real
host workspace paths, with no arbitrary shell-source rewriting.

## Validation and discovered differences

- Seventeen tests pass: native functionality/lifecycle/error cases and a shared
  contract against both native and original agentOS. Compile-time checks compare
  the extracted API signatures in both directions.
- Shared tests found the original attached-execution default is **no capture**;
  native now matches it. Explicit capture is required when reading result stdout.
  `retainEvents: true` is rejected for attached execution, matching the original
  no-context execution restriction.
- Empty-directory removal initially differed from the original API. Native now
  uses directory removal when appropriate rather than Node's non-recursive `rm`.
- Native tests cover 20 create/spawn/dispose cycles, persistent file reopen, no
  surviving managed root child, dispose/spawn races, bounded output/stdin/history,
  callback errors, missing executables, abort, timeout, shell exit status and UTF-8.
- The real OpenClaw tool probe passes write/edit/read, persisted native file,
  shell output/exit code 7, and timeout through the SDK adapter.
- Direct traversal/symlink tests are defensive path-validation tests, not evidence
  of a race-resistant security boundary. A real hostile-filesystem broker is absent.

## Hard limits on the result

`security: 'linux-sandbox'` fails before workload execution. The capability report
states `launcherImplemented: false` and `sandboxEnforcementVerified: false`.
Landlock querying and cgroup-delegation observations are retained separately in
`artifacts/results/native-sdk-preflight.json`. This is not an implemented sandbox
waiting for one configuration flag: a launcher/policy integration still needs to
be written and validated on a suitable host.

`security: 'trusted-only'` is mandatory to run the native backend here. Its local
output and managed-root limits are not RAM/CPU/PID cgroup limits. It cannot enforce
guest filesystem/network isolation or contain descendants escaping a process
group. Unsupported methods and options fail explicitly. User/provider secrets
and untrusted code must not be put into this diagnostic backend.

The native SDK adapter uses OpenClaw's interface named `sandbox` for routing, but
reports `sandboxed: false` in measurements. Original native tools and the SDK
variant are unprotected controls. The agentOS hybrid remains the existing runtime
alternative; none of these tests is a production security certification.

## Benchmark method

Three serial trials per configuration, alternating order, on the same two Linux
CPUs. Host Node 24.19.0, OpenClaw 2026.8.1, original SDK 0.2.19, 8 MiB semi-space,
and the same 32 KiB allocator profile. The unchanged representative fixture runs
21 turns / 105 tool calls, grows history to roughly 1 MiB, streams scripted model
responses, and executes two JavaScript tools per turn. Each turn includes 420 ms
of scripted response waits; there is no gateway, real provider, or tenant scheduler.

Process-tree PSS/RSS sampling includes the host and children. Warm CPU includes
reaped children and covers 20 warm turns. Launch-to-first-result covers imports
and adapter setup before the first result, with warm host file/package caches.
Build work is outside the measured process. Native core and files are shared in
architecture only within a run; all runs start fresh processes and workspaces.

The SDK supervisor implements fewer process features than OpenClaw's full native
supervisor. Lower overhead on this fixture cannot establish equal behavior for
PTY, background-session follow-up, unrestricted plugins, or arbitrary workloads.
Do not interpret this comparison as a security-preserving optimization until
Linux enforcement is implemented and the same trials are re-run with it enabled.

## Results

All nine trials passed every required checkpoint and workload assertion. Values
below are medians of the three per-run measurements; peaks show the range. Warm
latency is the median of per-run medians. RAM is MiB of process-tree PSS.

| Backend for native OpenClaw core | Active RAM | Retained idle RAM | Peak RAM range | CPU / 20 warm turns (s) | Warm turn (ms) |
|---|---:|---:|---:|---:|---:|
| Direct Node / original supervisor | 191.3 | 198.7 | 577–621 | 6.04 | 674.7 |
| Extracted SDK / trusted-only native | 185.7 | 198.6 | 500–676 | 4.25 | 608.3 |
| Published agentOS hybrid | 307.5 | 311.3 | 873–892 | 21.28 | 1339.7 |

The SDK preserves roughly native steady RAM on this fixture. Its warm CPU is
29.6% lower and median latency 9.8% lower than the original native supervisor,
but the supervisors have different feature coverage. Do not attribute this to a
kernel-sandbox optimization: no kernel policy is applied to the native variant.
Retained idle RAM is essentially equal to native; peak variation remains large
and the SDK's worst sampled peak exceeds the native control's in these trials.
Compared with agentOS, active RAM is 39.6% lower and warm CPU is 80.0% lower, with
the crucial difference that the SDK variant has no guest security boundary.

Median launch-to-first-result is approximately 1.57 s for the SDK, 1.89 s for
native, and 3.34 s for agentOS. Whole-run CPU (including startup/cleanup) is about
5.87 s, 8.15 s, and 25.55 s respectively. These are warm-file-cache, single-instance
measurements, not a serverless billing/capacity estimate. Post-disposal retention
of a long-lived OpenClaw host is not measured by these process-exiting trials.

Raw reports and summary: `artifacts/results/native-sdk-comparison.json` and its
listed trial files. The generated entry hashes match the measured files.
`native-sdk-build-manifest.json` records all SDK source/runtime hashes and the
standalone native bundle: **23,983 bytes**, with no npm runtime dependency inputs.
Bundle size is not process RAM. That manifest supplements the benchmark entry
hashes; preflight output is in `native-sdk-preflight.json`.

## Reproduce

```sh
npm run sdk:build
npm run test:sdk
npm run bench:build
npm run test:native-sdk
export BENCH_WORKLOAD=core-workload BENCH_WARM_TURNS=20 BENCH_IDLE_MS=1500
export AGENTOS_V8_WARM_ISOLATES=0
export MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=32768 MALLOC_MMAP_THRESHOLD_=32768 MALLOC_TOP_PAD_=0
python3 scripts/benchmark/measure.py --native --core --native-sdk --node-semi-space-mb 8 --cpus 2 --trial 1401
python3 scripts/benchmark/measure.py --native --core --node-semi-space-mb 8 --cpus 2 --trial 1401
python3 scripts/benchmark/measure.py --native --core --hybrid --node-semi-space-mb 8 --cpus 2 --trial 1401
```

Use unused trial numbers. Repeat serially in alternating order. The retained full
comparison uses trials 1301–1303; 1300 is a two-turn exploratory run before the
final contract corrections and is excluded from the summary.
