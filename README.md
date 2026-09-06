# OpenClaw core on agentOS

An out-of-tree experiment running OpenClaw **2026.8.1** core turns inside the
published **agentOS 0.2.19** runtime. No containers, OpenClaw source fork,
agentOS source changes, or Rust build are used in the current experiment.

**Status: the current core compatibility gate passes.**
The async-context and process-completion failures are fixed within the compiled
adapter boundary. This remains a prototype, not a production runtime.

## Current core boundary

- Uses the actual standalone worker from the published OpenClaw package.
- Verifies its SHA-256 before touching the generated artifact.
- Slices a pinned core profile, preserving selected declarations and eager initializer order.
- Rewrites ten retained import specifiers to local JavaScript compatibility modules.
- Lowers async functions and generators to promise continuations, preserving
  context through agentOS’s existing promise callback capture.
- Exposes the existing `runWorkerEmbeddedTurn` through a small wrapper that
  invokes its generated module initializer.
- Keeps OpenClaw's agent loop, coding tools, tool policy, transcript projection,
  and terminal-event ordering in the agentOS guest.
- Delegates SQLite to a scoped host Node SQLite service through agentOS's
  published binding API. The original table-metadata collector runs beside that
  connection in one call; schema validation and the SQLite safety check remain
  intact. Use `createCoreHostSqlite()` for the verified collector configuration.
- Persists workspace and transcript data through agentOS `chunked_local` mounts.

The reduced profile explicitly rejects gateway compaction and source extension
loading, which the existing embedded worker already disables. It removes the
worker CLI entry; gateway and channel integration remain separate work.
`CORE_PROFILE=full npm run core:build` retains the full control artifact.

These are **artifact patches**, even though neither source project is forked.
The private core boundary is version-specific, not a stable upstream SDK.

Inference is injected deterministically in the tests. No model API credentials
are needed, and guest network access is denied. The real OpenClaw core consumes
those responses and executes its real tools; the model's reasoning and external
provider transports are not tested.

## Results

| Test | Result |
| --- | --- |
| Core turn with `write`, `read`, `edit`, `exec`, `apply_patch` | Pass |
| Continued turn in the same guest process | Pass |
| Workspace and transcript restoration after VM disposal/recreation | Pass |
| Pre-aborted turn, inference failure, transcript failure | Pass |
| Read-only tool restrictions; recovery from missing-file errors | Pass |
| Host SQLite transactions, blobs, 64-bit integers, persistence and isolation | Pass |
| Existing provider contract tests | 11 pass |
| AsyncLocalStorage overlap, nesting, rejection, callbacks and generators | Pass with adapter + compilation; raw agentOS still fails |
| Foreground exec completion | Pass, status and exit code explicitly checked |
| Background exec followed by `process.poll` | Pass, actual exit codes 0, 7 and 127 retained |

See [the detailed report](docs/core-runtime-report.md),
[raw results](artifacts/results/core-probe.json), and
[standalone async-context evidence](artifacts/results/async-context.json).

## Reproduce

Tested on Linux x64 with host Node **24.19.0**, whose SQLite is **3.53.3**.
The SQLite host adapter requires `DatabaseSync.setAuthorizer`; older supported
Node versions of the historical provider alone are not sufficient evidence.

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm run check
npm run test
npm run test:host-sqlite
npm run core:build
npm run test:core
npm run probe:async-context
```

`test:core` and `probe:async-context` now exit **0**. The latter compares the
adapted runtime with native Node and retains raw-runtime failures as diagnostic
controls. Any divergence in the adapted path still fails the gate.
Run `npm run core:report` to regenerate the compact report after both probes.

`core:build` regenerates the large worker artifact under `artifacts/core/`.
That directory and installed dependencies are excluded from git and the source
archive. The source archive includes the repository's git history.

## Compilation boundary

Context-sensitive callbacks must pass through `scripts/compile-async.mjs`,
including injected inference and transcript callbacks. The build compiles the
static worker; the harness compiles its fixtures. Uncompiled plugins, dynamically
generated code and arbitrary native-await callbacks are **not covered**. Merely
installing the AsyncLocalStorage adapter does not fix native `await`.

Two retained stream-ponyfill reflection expressions (three in the full control) use a separate native async
iterator intrinsic. New upstream artifacts require review; this is more than an
import alias. The child-process adapter also depends on the pinned runtime’s
listener-table representation. See the report for these compatibility limits.

## Performance and placement

The [optional memory profile](docs/runtime-low-memory.md) reduces retained
memory after 51 turns from **465 to 385 MiB** across two runs per configuration.
It costs about **12% more warm CPU** and **14% higher median latency** in that
workload. `npm run test:core:memory` passes the full core gate; the existing
economy profile remains unchanged.

The [writable host-directory diagnostic](docs/writable-host-dir.md) observes
39 → 29 ms warm read turns in one comparison, but that backend permits writes
beyond the configured filesystem limit. It is **not adopted** for tenant data;
workspace/state keep their existing `chunked_local` mounts.

The [statement reuse experiment](docs/sqlite-statement-reuse.md) reduces host
statement prepares by **18%**, but repeated full-core runs do not establish a
warm CPU, latency or memory gain. It remains disabled by default. Enable it
with `CORE_SQL_STATEMENT_CACHE=32 npm run test:core:economy`.

The [canonical table experiment](docs/runtime-canonical-pass.md) reduces cold
SQLite calls from **1,373 to 961** and launch-to-first-result from **3.36 to
2.90 s** across three runs per configuration. It stays **opt-in**: warm CPU
increases about 4% and idle memory about 11 MiB. The default keeps the previous
table and index batching. Enable the experiment with
`CORE_CANONICAL_BATCHING=1 npm run test:core:economy`.

The [shell diagnosis](docs/wasm-shell-copy-cost.md) identifies a costly full
binary copy in the published runtime's memory-limit rewrite. A prepared
upstream patch preserves its checks and passes 156 differential cases, but is
**not applied or submitted**. Its isolated function speedup is not a delivered
agentOS runtime improvement.

The latest [startup pass](docs/runtime-startup-pass.md) shares read-only core
artifacts through a published mount and batches named-index inspection. In two
51-turn runs per configuration, staging falls from **492 to 16 ms**, cold SQL
calls from **1,700 to 1,373**, and launch-to-first-result from **3.58 to 3.24 s**.
Staging plus cold-turn CPU is about **16% lower**. Idle memory averages only
7 MiB lower with overlapping ranges; warm shell CPU and latency do not improve.

The [workload decomposition](docs/runtime-bottlenecks.md) finds near-Node speed
for the tested JS computation, but high filesystem and shell costs. Warm core
turns measure 25 ms without tools, 41 ms with read and 338 ms with read plus
shell exec, versus 4/9/27 ms on Node. These are different diagnostic workloads,
not reductions in the normal runtime capabilities.

The [runtime benchmark](docs/runtime-benchmark.md) measures a **16.6 MB compiled
core**, down from 53.6 MB. The new [memory and CPU pass](docs/runtime-memory-cpu.md)
reduces idle process-tree memory from **568 to 468 MiB** across repeated 51-turn
workloads, with sampled peak falling from **661 to 562 MiB**. Full-workload CPU
is about 3% lower; there is no established steady-state CPU gain. Warm turns
remain about 0.3 seconds. Direct Node on the same workload measures 324 MiB idle,
26 ms warm turns and much less CPU. These are local deterministic-inference
measurements, not production or Cloudflare cost evidence.

Use `npm run test:core:economy` for the current opt-in profile, or
`node scripts/run-core-economy.mjs your-core-host.mjs` to launch a core host.
It disables spare V8 isolates through `AGENTOS_V8_WARM_ISOLATES=0` and retains the
existing compact glibc allocator settings. The launcher checks the agentOS
version because that environment switch is internal to the published runtime.
The guest heap remains 256 MiB; all default software and shell tools remain.
`test:core:compact` retains the previous allocator settings and `test:core`
retains the runtime's default environment. Both now use the read-only code
mount; set `CORE_ARTIFACT_MODE=upload` for the previous staging path. See the
reports for measurements and rejected experiments.

[Schema batching](docs/schema-batching.md) first reduced cold binding calls
from 3,306 to 1,700; named-index batching now reduces that to 1,373 while retaining
the original metadata collectors, drift checks and rollback behavior. The host
collector is 12.9 KB; the guest bundle remains 16.6 MB.

A new multi-instance probe also found that agentOS 0.2.19 replaces host binding
handlers/policies when VMs share a sidecar. The core harness now requests its
own sidecar pool and explicitly disposes it after the VM. Separate-pool routing
and two concurrent core instances pass; shared-sidecar modes remain unsupported.
Run `npm run probe:bindings` for the standalone evidence. Closing a VM alone does
not reclaim all sidecar resident memory.

## Native core with agentOS tools experiment

[Matched benchmarks and boundary notes](docs/native-core-agentos-tools.md) compare
the guest core with a trusted native Node core delegating file/shell tools to
agentOS. This is an optional benchmark backend; it does not change the default
runtime. Run `npm run bench:build` and `npm run test:hybrid` for its independent
correctness probe.

A further [Node young-generation profile](docs/node-young-generation-memory.md)
reduces hybrid retained RAM from 386 to 292 MiB in matched trials, with about
5% more warm CPU. It is opt-in via `scripts/run-core-node-memory.mjs`; run
`npm run test:hybrid:memory` for the real-tool probe. Peak RAM remains high.

The [representative single-agent benchmark](docs/representative-workload.md)
adds 21 turns of repository searching, configuration edits, report writes,
child Node validation scripts, 16 KiB tool output, and approximately 1 MiB of
final history. The optimized hybrid measured 305 MiB active / 311 MiB retained
PSS; peak RAM remains 772–847 MiB. Model responses are still synthetic.

## Historical provider prototype

The original TypeScript `WorkerProvider`, embedded lifecycle driver and their
contract tests remain in `src/`. They have **not** been wired to this new core
experiment and are not production-runnable. Gateway enrollment, channels,
Cloudflare deployment and actor adoption remain outside this phase.

The Rust patch in `patches/` and `docs/agentos-patch.md` is historical and is
**not applied or needed** by the current tests. The raw builtin audit also
remains useful as evidence about the unchanged published runtime.

The experimental [Wasmer SDK comparison](docs/wasmer-sdk-comparison.md) runs the
same native OpenClaw core with Wasmer-backed file and shell tools, alongside
agentOS and native tool baselines.

## Planned native Linux SDK backend

The SDK-fork direction is recorded separately from the current published-runtime
experiments: [preflight](docs/native-linux-preflight.md),
[architecture](docs/native-linux-architecture.md), and
[implementation roadmap](docs/native-linux-roadmap.md). The first implementation
milestone is a backend contract preserving the agentOS API. Linux enforcement
requires host capabilities that are not available for validation in this environment.

The [extracted native Node SDK](packages/agentos-sdk/README.md) now implements the
filesystem/process/JavaScript slice and has a [test and benchmark report](docs/native-node-sdk-implementation.md).
Its native backend requires explicit trusted-only mode; Linux sandbox enforcement
is not implemented and protected execution fails closed.
