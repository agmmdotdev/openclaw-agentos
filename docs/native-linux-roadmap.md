# Native Linux SDK backend roadmap

Recorded 2026-09-06. Goal: keep the agentOS SDK experience while approaching native
Node efficiency with a measured Linux security boundary. Read the
[preflight](native-linux-preflight.md) and [architecture](native-linux-architecture.md)
before implementation. Checkboxes represent completed evidence, not intention.

## Implementation update — 2026-09-06

The [native SDK extraction](native-node-sdk-implementation.md) now implements a
trusted-only filesystem/process/JavaScript slice in `packages/agentos-sdk`.
Source commit and API types are pinned; native and original backends pass shared
contract tests. Native-only imports avoid the original runtime. Seventeen tests,
including 20 create/run/dispose cycles, and the real OpenClaw tool probe pass.

This advances M1 and the functional portions of M3/M4. M2 now has an
[experimental launcher, openat2 primitive and host acceptance runner](native-linux-enforcement-prototype.md).
The optional `filesystemBackend: 'linux-openat2'` now implements the extracted
filesystem slice including directory operations. An explicitly experimental SDK
process path connects the native launcher to a C monitor with manager-death
detection and child reaping. See [the supervision report](native-linux-sdk-supervision.md).
Thirty-eight SDK/primitive tests pass, including actual seccomp/Node compatibility,
descriptor retention and monitor-loop crash tests with test process-group controls;
Landlock/cgroup acceptance remains blocked, and protected SDK execution is disabled.
M5 protected-performance acceptance is not passed by the trusted-only
benchmark. Broader SDK/session/storage APIs remain deferred, with explicit errors.

## Milestones

| Milestone | Status | Depends on | Reviewable result |
|---|---|---|---|
| M0 — Preflight and design | Complete for available environment | — | These three documents; explicit host limitations |
| M1 — SDK source and backend contract | Implemented for extracted slice | M0 | Pinned source/fork base, API contract tests, backend seam |
| M2 — Linux launcher and host gate | Prototype implemented; host validation blocked here | M0 | Capability report and verified enforcement on suitable Linux |
| M3 — Native SDK slice | Trusted functionality implemented; enforcement blocked | M1, M2 | Filesystem/process lifecycle APIs with supported capability report |
| M4 — OpenClaw parity and security gate | Functional probe passes; security blocked | M3 | Real-tool and adversarial test results |
| M5 — Matched RAM/CPU comparison | Trusted comparison recorded; protected gate blocked | M4 | Reproducible raw samples and comparison report |
| M6 — Request lifecycle and retention | Deferred until M5 | M5 | Repeated create/run/dispose and crash-recovery evidence |
| M7 — Broader APIs and multitenant service | Deferred | M6 and separate scope | Explicit follow-on decisions |

## M1 — Start with the contract, not a sidecar rewrite

- [x] Locate the upstream source corresponding to npm SDK 0.2.19; record commit,
  package integrity, license/notice obligations, and a reproducible SDK build.
- [x] Establish a focused SDK fork/workspace without changing OpenClaw source or
  rebuilding/forking the Rust runtime. Record its maintenance and upstream-update
  policy. Implemented as `packages/agentos-sdk` in this repository; not a separately
  published npm package or a Rust-runtime fork.
- [x] Inventory the hybrid adapter's public calls and direct SDK sidecar coupling.
  Specify create/dispose, filesystem, process, event, cancellation, and error types.
- [x] Resolve native path semantics: use the exposed native workspace cwd first;
  document deviations from a virtual `/workspace`. Resolve supported limits and
  reject unsupported storage/permission options before execution.
- [x] Extract the backend interface for the selected slice and retain explicit
  selection of the original SDK through the factory.
  Make native imports avoid original runtime initialization and heavy eager imports.
- [x] Run shared contract tests against the current agentOS backend and the new
  interface. Record existing behavior gaps instead of treating them as desired
  semantics or quietly hiding them.

Exit: buildable SDK contract and unchanged existing-backend behavior on the
supported slice. Test doubles are allowed here but are never labeled sandboxes.

## M2 — Establish the Linux execution boundary

Candidate implementation: single-threaded C launcher, strict setup ordering,
  Landlock ABI 6 policy, syscall allowlist, checked cgroup limits, and host test
orchestration. Available primitive/Node tests pass. The checkboxes below still
require real host acceptance and final launcher/supervisor selection; source code
and a seccomp-only diagnostic do not satisfy the complete boundary gate.

- [ ] Run a reproducible host preflight on the actual target/delegated test host:
  available Landlock rights, seccomp support, controller delegation, privileges,
  required binaries/libraries, and architecture. Record verified capabilities,
  not only versions and binary presence.
- [ ] Evaluate a maintained launcher against the architecture requirements; select
  it and pin its version, or justify a minimal helper with explicit maintenance
  ownership. No alternative may bypass environment permissions.
- [ ] Implement creation ordering: validate paths/policy, allocate resource control,
  launch restricted child, confirm readiness, then accept tenant work. Ensure no
  tenant code or package initialization executes before restrictions are active.
- [ ] Validate filesystem and network denial, cross-process restrictions, descendant
  containment, RAM/CPU/PID controls, output limits, and whole-job cleanup.
- [ ] Return explicit capability errors when a requested guarantee is unavailable.
  Define behavior when the manager crashes; demonstrate cleanup under the selected
  supervisor/host deployment before claiming it.

Exit: enforceable launcher policy on a suitable host. Current environment has
Landlock `ENOSYS` and no established writable cgroup delegation, so this gate is
not passed here. `prlimit`, a directory prefix check, or a normal child process
cannot substitute for the required process-tree boundary.

## M3 — Implement the smallest useful native SDK backend

- [ ] Workspace handles carry immutable ownership/policy and do not boot an idle
  runtime. Files remain when handles/processes are disposed.
- [ ] Implement file read/write/stat/mkdir through race-resistant ownership checks.
- [ ] Implement spawn, streams, stdin, wait, cancellation and disposal, with bounded
  output, UTF-8 chunk handling, backpressure, and deterministic exit reasons.
- [ ] Track all descendants; prevent stale PIDs from targeting another job.
  Cleanup is idempotent even after partial initialization and repeated cancellation.
- [ ] Verify module loading uses native Node and the approved read-only runtime
  files; no original sidecar launches on the native path.
- [ ] Publish the supported API/capability matrix. Unsupported APIs and hard disk
  quota requests fail explicitly; future host-binding APIs remain unavailable.

Exit: SDK contract tests pass through real Linux enforcement, not only mocks.

## M4 — Prove OpenClaw behavior and the boundary

- [ ] Add a native-Linux adapter to the existing real OpenClaw filesystem bridge
  and process supervisor, keeping the same trusted native core artifact.
- [ ] Pass write/edit/read, shell stdout/stderr, exit code 7, stdin EOF, timeout,
  cancellation, and cleanup. Verify tools cannot silently fall back to host exec.
- [ ] Run the representative 21-turn fixture: 105 tool calls, native child scripts,
  streamed replies, checkpoint reloads, growing history, and exact file assertions.
  Adapt declared workspace paths consistently across controls; keep substantive
  work identical and record any fixture changes.
- [ ] Exercise cross-workspace reads/writes, traversal, symlink/rename races,
  malicious cwd/env, and inherited descriptor access using isolated test fixtures.
- [ ] Exercise network denial across the promised socket types, unauthorized signal
  and process inspection attempts, detached descendants, CPU loops, RAM pressure,
  PID pressure, and output flooding within bounded test limits.
- [ ] Verify no surviving children or leaked descriptors after failure/disposal,
  no modification outside the assigned workspace, and useful failure diagnostics.

Exit: functionality and the documented threat boundary both pass. This is not a
claim of exhaustive sandbox security or full agentOS/OpenClaw compatibility.

## M5 — Benchmark the actual protected configuration

Compare unrestricted native tools, the native-Linux backend, and the optimized
agentOS hybrid on the same host. Keep the existing Wasmer result as context;
re-run it only when answering a concrete comparison question.

- [ ] Freeze Node/core/SDK/launcher versions, hashes, native tool closure, fixture,
  CPU affinity, allocator settings, sandbox policy, and effective limits.
- [ ] Use serial runs in alternating order, at least three clean trials per backend;
  increase repeats only if variability obscures the decision.
- [ ] Measure process-tree active/idle/peak PSS and RSS, warm CPU-seconds and latency,
  plus matched end-to-end startup, first result, shutdown, and post-disposal RAM.
  Include manager/launcher/children and reaped child CPU; do not omit shared manager
  memory. Keep imports/initialization inside lifecycle measurements.
- [ ] Separate warm package/file-cache results from cold downloads and shared-core
  amortization. Label the synthetic model waits and excluded gateway/LLM work.
- [ ] Archive raw samples, capability/enforcement evidence, and the actual command
  and policy used. Failed security runs are not performance wins.

Working targets, not promised results: aim for no more than 15% active/retained
RAM overhead and 10% warm CPU overhead versus the fresh native control, while
beating the fresh optimized agentOS hybrid. Peak and cold-start regressions must
be reported separately. Failure to hit these targets triggers profiling or a
recorded tradeoff decision, not relaxed security or omitted costs. The historical
191 MiB / 6.00 s baseline is not a fixed target for different hosts/workloads.

## M6–M7 — Only after the initial comparison

M6 tests repeated request lifecycles, zero idle child processes, bounded host
retention, persistence/reopen, interrupted initialization, manager failure, and
recovery. Decide whether core workers remain warm or are evicted using measured
startup/RAM tradeoffs; sharing code does not imply shared mutable request state.

M7 separately scopes host bindings, additional languages and SDK convenience APIs,
PTY/background sessions, virtual/remote storage, network brokering, and an actual
multitenant scheduler. Preserve the eventual 4 GiB server goal, but derive admission
limits from measured concurrent peaks and reserved gateway/OS capacity. Do not
estimate tenant capacity by dividing RAM by the single-instance active median.

## Immediate next deliverable

The initial extracted SDK slice and trusted benchmarks are now implemented.
The next boundary milestone is M2: run the experimental launcher and its nine
candidate cases on a suitable delegated host, resolve policy/compatibility gaps,
complete supervision and SDK filesystem/process integration, and run adversarial
checks before enabling protected execution. The current
package explicitly rejects protected mode; moving it to a VPS alone does not
complete this implementation. See the implementation report for exact remaining gaps.


## Core work while protected-host acceptance is blocked (2026-09-06)

Implemented request-based native-core experiments and a bounded filesystem allocation optimization. See [core-request-lifecycle.md](core-request-lifecycle.md) for the compatibility matrix, checkpoint recovery rules, 24 comparison runs, supervisor control, retained startup outlier, and 21-request continuity followup. Forty-eight SDK tests and three checkpoint tests pass; the upstream stdin/EOF limitation is explicitly recorded.

The SDK can release all core process memory between requests in the tested workload, at a substantial startup CPU cost. Compile caching improves the repeated-start cost; peak RAM and cold-start tail latency remain unresolved. Next priorities are module/parser startup profiling and broader skill/package compatibility. Gateway, scheduling and protected Linux acceptance remain separate gates.

### Cold-start profiling followup

[Native core startup](native-core-startup.md) identifies the repeated transient
peak in V8's optimizing compilation of the Bash grammar. A version-pinned,
opt-in baseline-Wasm request launcher reduces matched cached-request peak PSS
from 673 to 237 MiB and seven-turn CPU from 10.06 to 8.07 seconds. Twelve paired
comparison runs, a 21-request continuity followup and a 19-case parser differential
pass. Idle resident RAM is unchanged. The historical 41-second startup remains
unexplained; next CPU work is JavaScript module/schema/highlighter initialization.
Protected-host acceptance and production execution remain disabled.

### Lazy native initialization and package compatibility

[Native lazy initialization](native-lazy-initialization.md) now defers the
highlighter and root configuration schema while preserving eager locale setup
and original validation. Twelve matched trials show another 8.5% reduction in
cached-request CPU and approximately 11 MiB less resident idle PSS. A 21-request
followup, eager/lazy behavior differentials and 50 SDK tests pass, including six
real npm packages with mocked network transports. Parser-heavy throughput now
quantifies the opt-in baseline-Wasm tradeoff: 54% more warm parsing time.
The next CPU target is source loading/compilation and additional safe deferral;
protected-host acceptance is still blocked.

### Separately loaded highlighter experiment

[Native highlighter module](native-highlight-module.md) extracts 195 original
declarations behind the synchronous getter and preserves per-core library state.
The entry shrinks 7.4%; resident idle PSS falls 3.6 MiB in 18 matched trials with
630 real tool calls. Cached CPU/latency do not improve, so the layout remains
opt-in. A new 5.7-second cached startup outlier is retained in the report.
Next: capture CPU profiles for delays before `worker-ready`, rather than assuming
further source splitting will improve end-to-end performance.

### Startup-tail diagnostics and single-start request launching

[Startup-tail investigation](native-startup-tail.md) captures 93 instrumented
requests without reproducing the historical isolated stalls. A separate verified
improvement removes the first of two Node startups from request launching, while
retaining the version guard, V8 flags and allocator. Six matched uninstrumented
trials show 8.5% lower CPU and 5.6% lower subsequent-request latency; RAM is
essentially unchanged. Seven focused tests and 710 real tool calls pass overall.
The rare stalls remain open: use phase capture to locate a repeatable slow stage
before attributing them to compilation, GC or SDK setup.


### Startup allocation profiling and schema consumers

[Startup allocation profiling](native-startup-allocations.md) identifies two eager
paths into unused-on-this-workload configuration schemas. Removing the discarded
channel schema and deferring root-support initialization cuts sampled allocation
estimates from 91.5–97.9 MiB to 76.5–79.8 MiB before readiness. Twelve matched
uninstrumented trials show 5.4% less cached-request CPU, 3.2% lower latency,
4.2% lower request peak PSS and 8.5 MiB less resident idle PSS. Full validation
still constructs the unchanged schemas on first use. The remaining eager core
schemas and module-loading costs are the next ordinary-startup targets; isolated
startup stalls still need an actual captured reproduction.

## Source-owned initialization follow-up

The [source initialization pass](source-core-initialization.md) removes eager broad-config imports from helper consumers and defers plugin-install validators. It includes immutable-artifact comparisons and request-level demand observations. Remaining source targets are model/catalog and computer-use initialization and separating terminal rendering from headless tool execution; Linux host enforcement remains a separate gate.

The [optimization ownership audit](source-optimization-migration.md) maps earlier
work to its current owners and moves SDK tool integration and request checkpoints
into the core package. Next compatibility work is complete process lifecycle
routing and broader real-tool coverage before default cutover. Benchmark and
deployment scripts remain tooling; further module deferral is a performance task.

The [SDK supervision follow-up](source-process-supervision.md) now reuses the
canonical process lifecycle owner for native SDK commands and binds all supervisor
operations to a turn. Real background-tool coverage includes input, polling and
kill across bindings. Next is the remaining filesystem/tool contract surface and
fresh performance evidence before default cutover; protected-host acceptance is
still separate.

The [SDK filesystem follow-up](source-filesystem-contract.md) now implements the
required bridge methods and atomic creation through the SDK, including bounded
reads and real patch add/move/delete coverage on both filesystem backends. Next:
freeze external benchmark dependencies and refresh matched performance before
considering the default switch; remaining startup deferral and broader skill
compatibility still need evidence.

The [frozen-dependency revalidation](source-runtime-revalidation.md) now compares
the current source runtime against fresh controls: cached peak PSS is 8.4% lower,
while seven-turn CPU is 3.8% higher and cached latency 1.7% higher. All 88 turns
and 440 real tools pass. Keep the default unchanged and use refreshed source
startup profiles to select the next module-initialization change.

The [validator initialization follow-up](source-validator-initialization.md) now
defers model/theme schema construction and computer-use validator compilation in
source. Frozen before/after comparisons show 2.8% less request CPU, 2.7% lower
cached latency and 2.8% lower cached peak PSS versus the previous source. All
126 benchmark turns, 630 real tools and 82 focused checks pass. Resident results
remain mixed, and the default stays unchanged. Next: separate terminal rendering
from headless tool execution across the tool-definition owners.
