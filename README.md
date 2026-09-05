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

The [runtime benchmark](docs/runtime-benchmark.md) now measures a **16.6 MB
compiled core**, down from 53.6 MB. With the tested glibc allocator settings,
the latest batching pass measures **3.50 seconds median to the first result**,
versus **4.46 seconds** with individual SQL calls. The five batched runs span
3.40–6.14 seconds; the slow outlier is retained. Idle memory remains about
520–547 MiB and warm turns about 0.3 seconds. Direct Node still measures around
1.17 seconds cold, 27 ms warm and 272 MiB idle. These are small local samples
with deterministic inference, not production cost or Cloudflare evidence.
See [schema batching](docs/schema-batching.md) for the code boundary and
in-guest drift/rollback comparisons. The guest bundle remains 16.6 MB; the
extracted host collector adds 12.5 KB.

Use `npm run test:core:compact` to exercise the tuned Linux configuration, or
`npm run bench:core -- --allocator compact --trial 30` to measure it. The
allocator profile sets `MALLOC_ARENA_MAX=1`, `MALLOC_TRIM_THRESHOLD_=65536`, and
`MALLOC_MMAP_THRESHOLD_=65536` before starting the host and sidecars. The ordinary
`test:core` command leaves allocator defaults intact. Settings need validation
for a future high-concurrency service.

A new multi-instance probe also found that agentOS 0.2.19 replaces host binding
handlers/policies when VMs share a sidecar. The core harness now requests its
own sidecar pool and explicitly disposes it after the VM. Separate-pool routing
and two concurrent core instances pass; shared-sidecar modes remain unsupported.
Run `npm run probe:bindings` for the standalone evidence. Closing a VM alone does
not reclaim all sidecar resident memory.

## Historical provider prototype

The original TypeScript `WorkerProvider`, embedded lifecycle driver and their
contract tests remain in `src/`. They have **not** been wired to this new core
experiment and are not production-runnable. Gateway enrollment, channels,
Cloudflare deployment and actor adoption remain outside this phase.

The Rust patch in `patches/` and `docs/agentos-patch.md` is historical and is
**not applied or needed** by the current tests. The raw builtin audit also
remains useful as evidence about the unchanged published runtime.
