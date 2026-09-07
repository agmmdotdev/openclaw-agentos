# SDK filesystem contract follow-up

PR #21 merged as `08f9199332d949ee7aa0012d027633a1721b5667`. This follow-up implements filesystem behavior in the owned core runtime and native SDK. The published worker is not rewritten.

## Observed failures

A real command against the preceding runtime wrote five bytes, requested `maxBytes: 2`, and received all five bytes. `remove` and `rename` were undefined, and a write to `new/child` failed with `ENOENT` although the core bridge defaults to creating parents. Creating the complete core filesystem tool set also failed because the SDK context omitted the mount configuration read by the core's workspace guards.

## Changes and ownership

- The core bridge returns relative/container paths, preserves an SDK-owned Buffer without another full-file copy, passes read limits and cancellation, honors string encoding and parent creation, translates only missing-file stat/removal outcomes, and implements rename/remove.
- Native `readFile` accepts an optional per-operation byte limit and signal. Both readers enforce the smaller of that limit and the handle ceiling while reading, including zero-byte reads. The Node reader retains its growth probes; the Linux transport passes the exact bound to the C helper and limits transport output too.
- Native `createFileExclusive` uses `O_CREAT | O_EXCL` through the selected backend's existing path owner. The core maps an actual `EEXIST` to `exists`. No check-then-write emulation is used. Atomic creation lets the existing `apply_patch` implementation add and move files without overwriting an existing destination.
- The SDK's new `NativeFileApi` extends the preserved extracted `FileApi` declaration. The original agentOS declaration slice is unchanged. Native stat/mkdir/move/remove/write operations also accept cancellation.
- Node operations check cancellation before dispatching filesystem mutations; reads check between chunks and writes pass the signal to Node's writer. Linux operations kill and drain their individual helper on abort and remove listeners before settling. Abort checks and Linux helper cancellation preserve custom reasons, including falsy values.
- Node regular-file opens use nonblocking mode so FIFOs cannot hang the reader before its type check. Writes check regular-file type before truncation. Missing-path resolution checks the existing ancestor before reporting absence, preserving outside-workspace errors under forced removal.
- The runtime supplies the empty bind configuration required by the existing core workspace guards. It does not add Docker execution or new mounts.

The optional streaming `copyFile` capability is still omitted. The required bridge methods and atomic-create extension reuse SDK operations, with no filesystem access fallback in the core adapter and no new dependency.

## Verification

Run after `npm run sdk:build`:

```sh
node --test --test-concurrency=1 packages/agentos-sdk/test/native.test.mjs packages/agentos-sdk/test/linux-filesystem-sdk.test.mjs packages/agentos-sdk/test/linux-primitives.test.mjs
npm run source-core:build
npm run test:source-runtime
npm run test:source-core
npm run source-core:build:minified
CORE_MINIFY=1 npm run test:source-runtime
npm run test:source-core:minified
```

The new bridge tests cover both actual SDK backends: exact/zero/oversized read limits, encoding, parent options, metadata, missing paths, recursive/forced removal, rename, rejected escapes, three concurrent exclusive creators, existing files/directories/symlinks, oversized creation, cancellation reasons and listener cleanup. A Node test injects real file growth after the initial stat and verifies bounded rejection plus descriptor closure. A real FIFO checks nonblocking rejection and `other` metadata classification.

The new real-tool tests execute eight `read`/`write`/`edit`/`apply_patch` calls per backend. They verify bytes on disk, patch add/move/delete, rejection of an existing destination, and rejection of a workspace escape. Expected rejections count as actual tool calls. Existing checkpoint, process supervision, config/schema and initialization checks remain in the source test commands.

Standard and minified layouts each passed 25 runtime/checkpoint tests plus nine core tests. The SDK regression set passed 33 tests. Final core validation executed 98 actual tool calls: 15 checkpointed-turn calls, 18 process calls and 16 filesystem calls per layout. The tool-runtime bundles are 41,594 bytes standard and 19,726 bytes minified; these are build sizes, not memory measurements. The SDK build includes its TypeScript check and C compilation. This does not claim a full-upstream typecheck, live-provider parity, CI result, or fresh automated-review pass; the existing user review waiver remains in effect.

## Limits and next work

Cancellation is not a transaction: it can leave created directories, an exclusively created file, a partial write, or a partially removed directory after work starts. Node filesystem syscalls already dispatched cannot be recalled. Atomic exclusive creation means no existing path is overwritten; it does not mean atomic publication of the entire file contents or rollback.

Existing backend restrictions remain. Node path checks are trusted-input defenses, not an atomic adversarial path boundary. Linux reads/writes reject symlinks, special files and multiply linked regular files; Linux stat can reject unsupported types instead of returning `other`. Linux helpers retain their existing operation, output, entry/depth and timeout limits. No wider process containment or protected-host acceptance is claimed.

The default remains the merged artifact runtime. This pass removes an avoidable read copy but makes no new CPU, latency or memory claim. Before default cutover, freeze external dependencies in the benchmark snapshots, run fresh matched performance comparisons, and investigate remaining eager model/catalog, computer-use and terminal initialization. Optional filesystem copy and broader skill/live-provider compatibility remain separate follow-ups.
