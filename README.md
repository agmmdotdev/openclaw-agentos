# OpenClaw core on agentOS

An out-of-tree experiment running OpenClaw **2026.8.1** core turns inside the
published **agentOS 0.2.19** runtime. No containers, OpenClaw source fork,
agentOS source changes, or Rust build are used in the current experiment.

**Status: core tool turns work; the compatibility gate intentionally fails.**
The tests found incorrect async-context propagation and an unresolved
background-process completion failure. This is not a production runtime.

## Current core boundary

- Uses the actual standalone worker from the published OpenClaw package.
- Verifies its SHA-256 before touching the generated artifact.
- Rewrites nine import specifiers to local JavaScript compatibility modules.
- Exposes the existing `runWorkerEmbeddedTurn` through a small wrapper that
  invokes its generated module initializer.
- Keeps OpenClaw's agent loop, coding tools, tool policy, transcript projection,
  and terminal-event ordering in the agentOS guest.
- Delegates SQLite to a scoped host Node SQLite service through agentOS's
  published binding API. OpenClaw's SQLite safety check remains intact.
- Persists workspace and transcript data through agentOS `chunked_local` mounts.

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
| AsyncLocalStorage across overlapping awaits | **Fail in published agentOS, independently reproduced without adapters** |
| Background exec followed by `process.poll` | **Fail: output arrives, completion has unknown exit code** |

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

`test:core` and `probe:async-context` currently exit **1** because the known
compatibility failures are assertions, not skipped tests. Passing core results
and failing cases are written together to `artifacts/results/`.

`core:build` regenerates the large worker artifact under `artifacts/core/`.
That directory and installed dependencies are excluded from git and the source
archive. The source archive includes the repository's git history.

## Historical provider prototype

The original TypeScript `WorkerProvider`, embedded lifecycle driver and their
contract tests remain in `src/`. They have **not** been wired to this new core
experiment and are not production-runnable. Gateway enrollment, channels,
Cloudflare deployment and actor adoption remain outside this phase.

The Rust patch in `patches/` and `docs/agentos-patch.md` is historical and is
**not applied or needed** by the current tests. The raw builtin audit also
remains useful as evidence about the unchanged published runtime.
