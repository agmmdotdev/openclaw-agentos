# Native Linux SDK backend roadmap

Recorded 2026-09-06. Goal: keep the agentOS SDK experience while approaching native
Node efficiency with a measured Linux security boundary. Read the
[preflight](native-linux-preflight.md) and [architecture](native-linux-architecture.md)
before implementation. Checkboxes represent completed evidence, not intention.

## Milestones

| Milestone | Status | Depends on | Reviewable result |
|---|---|---|---|
| M0 — Preflight and design | Complete for available environment | — | These three documents; explicit host limitations |
| M1 — SDK source and backend contract | Next | M0 | Pinned source/fork base, API contract tests, backend seam |
| M2 — Linux launcher and host gate | Pending; host validation blocked here | M0 | Capability report and verified enforcement on suitable Linux |
| M3 — Native SDK slice | Pending | M1, M2 | Filesystem/process lifecycle APIs with supported capability report |
| M4 — OpenClaw parity and security gate | Pending | M3 | Real-tool and adversarial test results |
| M5 — Matched RAM/CPU comparison | Pending | M4 | Reproducible raw samples and comparison report |
| M6 — Request lifecycle and retention | Deferred until M5 | M5 | Repeated create/run/dispose and crash-recovery evidence |
| M7 — Broader APIs and multitenant service | Deferred | M6 and separate scope | Explicit follow-on decisions |

## M1 — Start with the contract, not a sidecar rewrite

- [ ] Locate the upstream source corresponding to npm SDK 0.2.19; record commit,
  package integrity, license/notice obligations, and a reproducible SDK build.
- [ ] Establish a focused SDK fork/workspace without changing OpenClaw source or
  rebuilding/forking the Rust runtime. Record its maintenance and upstream-update
  policy. Repository creation has not happened in this documentation milestone.
- [ ] Inventory the hybrid adapter's public calls and direct SDK sidecar coupling.
  Specify create/dispose, filesystem, process, event, cancellation, and error types.
- [ ] Resolve native path semantics: use the exposed native workspace cwd first;
  document deviations from a virtual `/workspace`. Resolve supported limits and
  reject unsupported storage/permission options before execution.
- [ ] Extract the backend interface and keep the current backend behind it.
  Make native imports avoid original runtime initialization and heavy eager imports.
- [ ] Run shared contract tests against the current agentOS backend and the new
  interface. Record existing behavior gaps instead of treating them as desired
  semantics or quietly hiding them.

Exit: buildable SDK contract and unchanged existing-backend behavior on the
supported slice. Test doubles are allowed here but are never labeled sandboxes.

## M2 — Establish the Linux execution boundary

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

M1: a pinned SDK source map, supported API contract, and a backend-interface PR.
M2 requires a suitable Linux host before its enforcement gate can be accepted.
The documentation and SDK refactor can advance independently of that host access;
no sandbox implementation or benchmark success is implied by this roadmap.
