# Source-owned OpenClaw core

This package builds the embedded core from editable TypeScript source pinned to OpenClaw 2026.8.1, commit `ea806575e6450e4d1efdfc72c19f04be982a1b9b`. It does not read or rewrite the published worker bundle. The merged artifact pipeline remains the active reference while this migration completes review and performance validation.

The `upstream/` directory contains the resolved runtime and type dependency closure, with upstream licenses, package metadata, and instructions. `provenance.json` records original Git blob IDs. The original commit and its history remain available from https://github.com/openclaw/openclaw.git; this is a selective source import, not a copy of the complete upstream Git history. The added modules and changed source files implement the downstream adaptations.

AgentOS already has owned source in `../agentos-sdk`; this migration uses that package's native entry. It does not import the Rust/Wasm engine. The native backend remains trusted-only.

## Build and verify

From the repository root, after installing the existing root dependencies and building the SDK:

```sh
npm run core:build  # builds the merged reference used by parity tests
npm run source-core:install
npm run source-core:build
npm run test:source-core
```

The new package has its own locked supplemental build dependencies. The build also resolves third-party dependencies and parser assets through the existing pinned OpenClaw installation. That installation is still required as a dependency supplier and for the comparison tests; its compiled worker is never a source-build input.

`dist/index.mjs` is the runtime entry. `dist/diagnostics.mjs` is a separate diagnostic build with schema-initialization observations. It is not the runtime entry. Builds include source maps, input dependency graphs, output hashes, and the parser WASM assets.

## Runtime API

`src/index.ts` exports `runOpenClawCoreTurn(params)`. It accepts the existing embedded-worker turn parameters, with an optional `toolRuntime` containing the SDK's filesystem/backend context and process `supervisor`. The filesystem context uses OpenClaw's historical `sandbox` interface name; that name does not establish a security boundary.

The embedded worker passes the context directly to tool construction. An async-local route binds all supervisor methods to their owner and refuses retained callbacks after the turn closes. This replaces the benchmark's reassignment of generated functions and the global supervisor's spawn method.

## Source adaptations

- Gateway compaction and source extension loading fail explicitly, matching the existing embedded profile.
- A synchronous bundled loader defers the complete configuration schema. English locale initialization stays eager and is shared, so loading the schema does not reset a later custom locale.
- MCP name schemas and channel runtime adapters are split from unrelated schema construction.
- Highlighting loads on demand; runtime replacement and explicit clearing cancel pending loading.
- Canonical SQL schemas are imported as text, and parser WASM assets are packaged beside the entry.

## Validation and remaining gates

Four focused tests passed: exact comparison of all 28 existing configuration cases and locale results against the merged core, including an instrumented check of deferred, once-only schema initialization; isolation and revocation of SDK process routing; three separate request processes with 15 real tool calls and continuous transcript checkpoints; and highlighter demand/replacement behavior. A separate two-turn resident run completed ten real tool calls with the packaged parser assets.

These checks use scripted inference and actual filesystem/process tools. They do not establish live-provider parity, a sandbox boundary, or a new performance improvement. Whole-upstream type checking and tests have not run. The default launcher has not switched to this package.

The imported `upstream/AGENTS.md` requires a fresh Autoreview pass before a nontrivial commit. Its dry run was blocked because the `codex` reviewer executable is unavailable; it also rejected the large untracked upstream lockfile during bundle preparation. The repository owner explicitly waived this requirement for this migration on 2026-09-07 and authorized manual review plus the completed tests. No clean automated review is claimed. The prior PRs #14–#17 are already merged into the parent repository's main branch.

## Performance comparison

The [matched performance report](../../docs/source-core-performance.md) found that the minified source build reduces cached-process peak PSS but still increases CPU and request latency versus the merged reference. The default runtime remains unchanged.

`npm run source-core:build:minified` produces `dist/minified-index.mjs`, a separate minified runtime candidate, plus diagnostics and the matched benchmark fixture with esbuild minification and function-name preservation. Run its focused checks with `npm run test:source-core:minified`. The standard artifacts remain available as controls.

The [source initialization pass](../../docs/source-core-initialization.md) separates narrow config helpers and SecretRef schemas from broad schema construction, and defers install validators to first parse. Six focused tests now run for either build layout, including persisted-record and channel-metadata contracts. The default remains the merged artifact runtime.

## Owned SDK integration and request state

The package's `./tool-runtime` subpath exports `createAgentOsToolRuntime(vm, { env })`.
Pass its `{ sandbox, supervisor }` result as `toolRuntime` to `runOpenClawCoreTurn`;
create the native SDK handle first. Await `supervisor.shutdown()` during teardown,
then dispose the handle in a `finally` block. The `./request-state`
subpath exports `beginRequest(stateDir, turn)` for the existing single-session
checkpoint protocol. Build the tool-runtime entry with `npm run source-core:build`;
the checkpoint module remains native ESM source.

`npm run test:source-runtime` checks these runtime boundaries. See the
[optimization ownership audit](../../docs/source-optimization-migration.md) for
the complete migration mapping, repaired stdin/timeout behavior, and remaining
compatibility work. The [process supervision follow-up](../../docs/source-process-supervision.md)
connects SDK commands beneath the shared supervisor, including background tools,
scope cancellation and deadlines. It documents the remaining unsupported modes.
