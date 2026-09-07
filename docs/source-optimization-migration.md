# Optimization ownership audit

Updated 2026-09-07 after merging PR #19 at `0126cb5d128c0f7e62fcdc07752a05b15a71bc39`.

All adopted native initialization optimizations now have source implementations.
This follow-up moves the two remaining reusable runtime implementations out of
scripts: the OpenClaw/AgentOS tool bridge and request checkpoint persistence.
The artifact runtime remains the default/reference. Migration of ownership does
not establish complete process-supervisor compatibility or a performance win.

## Runtime changes in this follow-up

`packages/openclaw-core/src/sdk-tool-runtime.mjs` owns filesystem routing, cwd
validation, process spawning, UTF-8 streaming, stdin and termination translation.
`createAgentOsToolRuntime(vm, { env })` borrows an already-created native SDK handle;
the caller owns its disposal. Workspace paths come from the SDK's canonical root.
Only SDK filesystem calls convert to relative paths for `linux-openat2`.
The benchmark adapter retains environment selection, handle creation/disposal,
and read/stat/shell counters. It no longer implements the bridge.

The extraction also fixes two reproduced process-contract bugs:

- SDK deadlines returned `reason: "timeout"`; OpenClaw expects
  `"overall-timeout"`. Its exec output uses that reason to append timeout retry
  guidance. Explicit timeout cancellation now sets the corresponding flags too.
- `stdin.write` ignored the callback awaited by OpenClaw's process input helper.
  It now completes that callback on successful SDK writes and passes write errors
  to it. Promise-based direct callers remain supported.

Exec preparation now spells the existing open-pipe behavior `pipe-open`, as
required by OpenClaw's contract. This does not implement other stdin modes.

`packages/openclaw-core/src/request-state.mjs` is an unchanged move of the
checkpoint implementation: exclusive admission marker, sequence validation,
32 MiB limit, atomic checkpoint replacement with fsync, and explicit recovery
after interruption. The old script module is removed and its current callers
are updated. Historical generated benchmark files must be rebuilt.

The package exposes lightweight `./tool-runtime` and `./request-state` subpaths.
These native ESM modules need no bundle rewriting and do not import the core
schema/model graph or create an SDK handle at module initialization.

## Mapping of earlier work

In this table, `core/` means `packages/openclaw-core/upstream/src/`.

| Optimization | Current owner and disposition |
|---|---|
| Embedded core slicing; omitted gateway compaction and source extension loading | Source entry plus `core/context-engine/delegate.ts` and `core/agents/sessions/extensions/loader.ts`; ordinary bundling replaces artifact slicing for the source build. |
| Lazy root configuration validation | `core/config/zod-schema-loader.ts`, `validation-core.ts`, and `schema-base.ts`. |
| Eager locale setup without resetting custom locales | `core/config/zod-default-locale.ts`. |
| Avoid unused channel-policy schema construction | Narrow `core/channels/plugins/config-schema-runtime.ts`, consumed by bundled channel metadata. |
| Avoid eager root-support schemas for MCP names | `core/config/zod-schema.mcp-names.ts`. |
| Lazy highlighter with replacement/clearing semantics | `core/worker/worker-deploy-highlight-runtime.mjs` and `worker-deploy-runtime-registry.ts`. |
| Broad config helper separation and lazy install validators | PR #19 source changes in `core/config/` and `core/plugins/installed-plugin-index-store.ts`. |
| Native SDK without the original sidecar | `packages/agentos-sdk/src/native.ts`, `native-entry.ts`, and filesystem/process owners. |
| Smaller initial file-read allocation | `packages/agentos-sdk/src/filesystem.ts`; size-informed first allocation and bounded growth. |
| Direct tool runtime and turn-local spawn routing | `core/worker/embedded-agent.runtime.ts` and `core/process/supervisor/index.ts`; this follow-up moves the bridge into `packages/openclaw-core/src/sdk-tool-runtime.mjs`. |
| Restartable request checkpoints | Moved unchanged to `packages/openclaw-core/src/request-state.mjs`; benchmark scheduling remains in the lifecycle harness. |
| Compile cache, baseline Wasm, young-generation and allocator settings | Deployment settings in `scripts/run-core-node-request.sh`, its preload guard, and the lifecycle harness. They belong outside application logic. |
| Remove duplicate Node startup | The shell launcher performs one `exec node`; the old launcher remains comparison tooling. |
| Source minification with function-name preservation | Normal build settings in `packages/openclaw-core/build.mjs`; remains opt-in. |
| Physically separate highlighter module | Unported opt-in experiment in `scripts/split-native-highlight.mjs`. Lazy source initialization does not mean a separate output file. Prior results did not justify adopting it by default. |
| Guest async lowering and Node compatibility | `scripts/compile-async.mjs` and `src/core-compat/`; specific to the old guest backend. Native source uses Node's actual builtins and async execution. |
| SQL metadata batching and statement reuse | Old guest/host transport in `src/core-host-sqlite.mjs`, `src/host-sqlite.mjs`, and compatibility adapters. Native SQLite has no corresponding guest transport to optimize. Some variants remained opt-in. |
| Shared artifact staging and verified streaming | Already runtime source in `src/core-artifact-store.mjs`; the native path does not upload code into a guest. |
| Sidecar/guest heap economy, Wasmer and writable-directory alternatives | Backend-specific configuration or historical experiments; they are not missing native source migrations. |
| Linux filesystem/process enforcement | Owned SDK and native helper source; suitable-host enforcement acceptance remains unresolved. |
| Fixtures, profiling, artifact hashing and benchmark summaries | Development tooling, appropriately retained as scripts. |

## Remaining work before default cutover

The bridge still supports the measured foreground file/shell slice. It does not
claim the full upstream `SandboxContext`, filesystem bridge, or `ProcessSupervisor`
contract. The next compatibility milestone is the process lifecycle owner:

- Implement coherent registration, scope cancellation/joining and retained-run
  behavior. Current async-local routing replaces only `spawn`; other supervisor
  methods still use the original registry.
- Cover automatic no-output deadlines, all required stdin modes, output capture,
  complete run metadata/results, and output detachment/extinction semantics.
- Close filesystem bridge gaps such as remove/rename, abort/size/encoding options,
  and complete resolved-path metadata before advertising broader tool support.
- Add real process-tool/background interaction coverage and broader provider/tool
  compatibility. The callback repair alone is not a complete background-session
  implementation.

Then rerun matched source/reference performance before switching the default and
retiring the native artifact rewrite path. The latest source CPU/latency gap and
unexplained startup stalls from [the initialization report](source-core-initialization.md)
remain open; this ownership refactor makes no new performance claim.

Before the next performance comparison, extend artifact freezing to externally
imported runtime dependencies. The build manifest records adapter/checkpoint
hashes, but the lifecycle harness currently verifies its entry/core snapshots
without rechecking every imported dependency against that manifest during a trial.

## Validation

Run from the repository root:

```sh
npm run test:source-runtime
node scripts/benchmark/build.mjs
npm run source-core:build
npm run test:source-core
npm run source-core:build:minified
npm run test:source-core:minified
python3 scripts/benchmark/probe-hybrid.py --native-sdk --request-profile
git diff --check
```

The timeout and stdin-callback assertions both failed against the pre-change
adapter using real child processes. Seven focused runtime/checkpoint tests pass,
including both native filesystem implementations, Unicode stdin/EOF and exit 7,
callback errors, deadlines/cancellation, canonical workspace paths, ordered
checkpoint reopening, and SIGKILL interruption recovery.

Both source layouts build successfully and pass all six existing focused tests.
Their six separate request processes complete 30 real tool calls with continuous
checkpoint history. The existing native request-profile probe also passes five
real write/edit/read/exec/timeout calls through the extracted bridge. Package
self-imports resolve both lightweight subpaths; whitespace checks pass.

The minified core bundle remains byte-identical to merged PR #19, SHA-256
`6a6e3bbc3b0ab980b8b2b9a1144639c2b401b73469e748a11990a2b703577191`.
The separately imported bridge changes, so this is not evidence of unchanged
whole-runtime performance. No new timing comparison is claimed.

The user's existing source-migration automated-review waiver remains applicable;
manual review found no blocking regression in this bounded extraction, without
a fresh automated-review claim. Full-upstream typechecking and live-provider
tests have not run.
