# Source-core initialization: schema ownership and demand

This pass changes editable OpenClaw TypeScript in `packages/openclaw-core/upstream/`. It separates lightweight validation consumers from the broad configuration schema and constructs plugin-install validators only when parsing needs them. The default runtime remains the merged artifact implementation.

## Source changes

Three eager import edges previously initialized `zod-schema.core.ts`: provider-overlay lookup, DM-policy dependency checks, and official-channel SecretRef metadata. Provider lookup now imports its existing `model-provider-config.ts` owner. DM policy has a small shared module. The unchanged SecretRef schemas have their own module, shared by metadata and broad config validation. Existing schema-module re-exports retain the other internal callers.

Plugin-install record and installed-index schemas now have cached synchronous getters. Helpers for empty maps, map access, serialization, and absent index rows do not construct validators. A real parse constructs the same concrete Zod objects, preserving passthrough fields, strict accepted-surface validation, normalization, and null-on-invalid behavior. The internal `PluginInstallRecordSchema`/`PluginInstallRecordShape` exports were replaced by `getPluginInstallRecordSchema`; all owned callers were updated. This is not a change to the source-core public API.

English locale registration stays eager and shared. First-demand schema construction does not reset a custom locale. Official-channel SecretRef JSON conversion still occurs at its original module boundary, using the same schema and cloning behavior.

## Measurements

| Runtime | CPU / seven turns | Cached request median | Cached-process peak PSS | Whole-trial peak PSS |
|---|---:|---:|---:|---:|
| Prior minified source | 23.51 s | 3,263 ms | 167.1 MiB | 217.4 MiB |
| Updated minified source | 22.32 s | 3,162 ms | 161.0 MiB | 208.7 MiB |
| Merged artifact control | 21.55 s | 3,051 ms | 175.6 MiB | 215.4 MiB |

Versus the previous source build, total seven-turn CPU is **5.1% lower**, cached-request median latency **3.1% lower**, and cached-process peak PSS **3.6% lower**. Cached-process CPU median is **5.3% lower**.

Versus the fresh merged controls, the updated source still uses **3.5% more total CPU** and has **3.7% higher cached-request latency**, with **8.3% lower cached-process peak PSS**. Some per-trial ranges overlap; these are modest local improvements, not proof of a consistent win for every request. Both paths release core memory when the process exits.

The minified artifact is essentially unchanged in size: 12,303,403 → 12,303,635 bytes. This gain comes from changing when source-owned schemas initialize, not a smaller build.

These are local deterministic-inference measurements, with actual filesystem and process tools. Nine accepted trials run seven turns each. Three variants rotate in order: before/after/merged, after/merged/before, merged/before/after. Each trial starts with an empty Node compile cache and uses the same workload, Node 24.19.0 request flags, allocator settings, two-CPU affinity, and 40 ms process-tree PSS sampling. The sampler's memory and CPU are excluded. PSS sampling can miss short peaks. Statistics are medians of per-trial statistics; three trials do not establish production tail behavior.

The baseline and candidate have separate immutable filenames. The harness checks artifact hashes before and after every request and before saving a report. The summarizer requires one consistent source hash per variant and different hashes between variants. No build or test runs overlapped the accepted comparisons.

The initial comparison attempt swapped artifacts at the same path. Its before-labeled reports recorded the candidate hash, so all nine trials in that block are rejected as performance evidence. Their successful behavior checks and raw results remain available, with a rejection manifest. The stricter summarizer rejects that block. These results are not used in the table.

## Validation and initialization evidence

All six focused tests pass in both standard and minified builds. They cover the existing 28 exact config/locale comparisons, concurrent SDK routing and revocation, three request processes with 15 real tool calls per build, deferred highlighting, plugin-record/index parsing, DM rules, and SecretRef validation and channel metadata widening. The channel test exercises `qqbot` at both top-level and account scope and checks input/result isolation.

The expanded schema-initialization assertion failed on the pre-change build with `Configuration graph initialized eagerly`. It now confirms four broad schema modules remain deferred on import and initialize once when full config validation is requested. Separate factory observations prove install schemas remain unconstructed on helper-only paths and construct once on first parse.

Three additional instrumented request processes executed 15 real tool calls with continuous checkpoints. Broad config-schema initialization and both install-schema factory counters remained empty through all three requests. See `artifacts/results/source-initialization-demand.json`. This checks demand during actual tool execution, beyond an import-only probe.

`observe-source-initializers.mjs` creates a diagnostic copy of the unminified runtime that labels esbuild's module callbacks and subtracts nested initialization from exclusive time. It never changes the runtime input or its source, and removes the now-invalid source-map link from the diagnostic copy. Its before/after observations identify module participation, not a matched timing improvement: the retained standard baseline predates dependency restoration, and instrumentation perturbs execution. Factory demand observations and uninstrumented minified trials provide the stronger proof for this change.

An earlier seven-turn baseline run, trial 26090730, contained an **18.18-second** request, with **11.99 seconds CPU**. `worker-ready` arrived at 16.73 seconds, before the ordinary tool workload. That boundary includes module loading, SDK setup, and checkpoint opening; it does not identify the root cause. The raw run is retained separately. The older 5.7-second and 41-second stalls also remain unexplained; no tail-latency fix is claimed.

## Evidence and reproduction

- Accepted baseline trials: 26090760, 26090762, 26090764.
- Accepted candidate and merged-control trials: 26090761, 26090763, 26090765.
- Summary and archive hashes: `artifacts/results/source-initialization-summary.json`.
- Raw accepted results: `artifacts/results/lifecycle-*-2609076*.json.gz`.
- Rejected comparison: `artifacts/results/source-initialization-rejected-comparison.json` and its referenced archives.
- Module observations: `artifacts/results/source-initialization-modules-{before,after}.json.gz`.

Build prerequisites remain in `packages/openclaw-core/README.md`:

```sh
npm run source-core:build
npm run test:source-core
npm run source-core:build:minified
npm run test:source-core:minified
node scripts/diagnostics/observe-source-initializers.mjs packages/openclaw-core/dist/index.mjs
```

The historical baseline was commit `f6427b5d16d8c17491154e55bf72d136bf9e64da`. Its unfrozen reports and original summary remain archived. The current initialization summarizer requires frozen provenance and intentionally rejects those historical reports. For a new comparison, use the complete baseline/index/tool-runtime snapshot workflow in the [validator initialization follow-up](source-validator-initialization.md).

The runtime source diff is 20 net added lines after the schema moves; growth is the cached factory/getter boundary. Diagnostic tooling, tests, reports, and locks are counted separately.

## Remaining work

Further module-init candidates include model-catalog loading, computer-use contract schemas, and terminal/TUI imports used by tool definitions. The current change does not separate those renderers. Each needs demand tracing and a fresh end-to-end comparison before claiming a gain.

No default switch, dependency upgrade, live-provider parity, whole-upstream type-check, or sandbox-enforcement claim. The existing source-migration waiver permits manual review and focused tests; no fresh automated-review pass is claimed. The README overview was also corrected because it still described the repository as having no owned source.

The next [validator initialization pass](source-validator-initialization.md) now
defers the private model/theme schemas and computer-use compilers. It includes
fresh profiles, real request-level demand checks, and one frozen dependency
snapshot covering both source revisions and the artifact control. Terminal
rendering remains a separate source ownership target.
