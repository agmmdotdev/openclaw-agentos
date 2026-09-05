# The shell startup copy cost

The published agentOS 0.2.19 WASM runner rewrites module memory limits before
instantiating each command. Its `enforceMemoryLimit()` copies the entire binary
one byte at a time into a growing JavaScript number array, then copies that
array into a Buffer. This includes code and data sections that need no change.
The published coreutils shell is about 3.09 MB, so this creates substantial
temporary allocation and CPU work on each invocation.

This is a specific runtime implementation cost, not evidence that Node or
Linux-compatible shells inherently require the measured overhead. The runtime
source at tag `v0.2.19`, commit
`9ae6abbdc48391a75b8336e7832b3e76f42616ee`, matches the routine inspected in the
installed sidecar. The full source file SHA-256 used for the patch proof is
`ccc7468514a8f99151ca4226617b85a48c44ff6b9cb3674b931af8d911ae9e4d`.

## Measured runtime phases

`probe-shell-startup.mjs` enables the published runner's diagnostic flag only
for the measured commands. Each case executes one initial and five subsequent
operations, checking exit code, stdout and diagnostic-only stderr. These are
instrumented primitive measurements, separate from the OpenClaw benchmark.

| Warm phase mean | Shell builtin printf | Direct cat |
| --- | ---: | ---: |
| Memory-limit rewriting | 59.6 ms | 13.2 ms |
| WebAssembly.Module | 5.2 ms | 0.8 ms |
| WebAssembly.Instance | 1.0 ms | 0.2 ms |
| wasi.start | 29.0 ms | 11.2 ms |
| Complete host-observed invocation | 160.1 ms | 78.7 ms |

The complete interval also includes work outside these runner phases. The raw
report includes shell-plus-cat operations; parent wasi.start can include child
execution, so nested phase times must not simply be added as independent costs.
An earlier two-operation exploratory shell probe showed 76–87 ms in memory
rewriting. The retained report above uses the economy environment and five warm
samples. These diagnostics identify a material cost; they do not measure the
speed of a patched runtime.

## Prepared upstream patch — not applied

[agentos-wasm-memory-copy.patch](../patches/agentos-wasm-memory-copy.patch)
changes only the copying strategy: retain views of unchanged sections, retain
the existing memory-section validation and rewrite, then concatenate the small
list of byte chunks once. It keeps the same memory ceilings, minimum checks,
unsupported-flag rejection, section bounds and binary output. It does not turn
off or weaken memory enforcement.

The verifier applies this patch to a temporary source file and extracts the
original and proposed functions for comparison. **156 cases** compare bytes
or error messages, including capped and uncapped declarations, malformed
sections, unsupported flags, limits below initial memory and multibyte LEB
values. A real instantiated module can grow to its configured ceiling and
fails to grow beyond it under both implementations. The real shell output
binary is byte-identical and passes WebAssembly validation.

In an isolated Node test, two groups of ten operations per implementation,
ordered original/proposed/proposed/original, give:

| One memory-limit rewrite of the shell | Original | Proposed |
| --- | ---: | ---: |
| Mean elapsed time | 77.45 ms | 0.46 ms |
| CPU per ten-operation group | 0.828 CPU-s | 0.0074 CPU-s |

CPU includes the byte-equality assertion after each operation. Garbage
collection is requested before each group, outside its timing. This is a
function-level proof, **not an agentOS or OpenClaw performance result**.
The patch has not been applied to the installed sidecar or submitted upstream.
The runner is embedded in that sidecar; using this change in normal execution
requires an upstream release or a runtime rebuild. The project continues using
the published binary and has no agentOS fork.

## Shell binary optimization was not adopted

Binaryen 132.0.0, optimize level 2 / shrink level 2, initially emitted newer
features when configured with `Features.All`. That output was rejected by V8
and agentOS. Restricting features to MutableGlobals, NontrappingFPToInt,
BulkMemory, BulkMemoryOpt and SignExt produces a valid candidate after two
optimization passes. It shrinks from 3,090,134 to 3,040,622 bytes (1.6%).

A separate software package executes control and candidate printf commands in
control/candidate/candidate/control order. The control warm group means are
130.4 and 123.2 ms; candidate means are 126.5 and 124.3 ms. That difference is
too small and variable to justify replacing the published shell and maintaining
another transformed command artifact. No production shell binary changes were
made. The raw experiment records the settings, hashes, timing arrays and scope.

## Reproduce the retained diagnostics

```sh
node scripts/run-core-economy.mjs scripts/diagnostics/probe-shell-startup.mjs
```

For the upstream patch proof, obtain the pinned runner source from
`crates/execution/assets/runners/wasm-runner.mjs` at the tag above, and the
`bin/sh` file from `@agentos-software/coreutils@0.3.4`'s package. The verifier
checks both hashes before applying the patch to a temporary copy:

```sh
node --expose-gc scripts/diagnostics/verify-wasm-copy-patch.mjs /path/to/wasm-runner.mjs /path/to/published-sh
```

Results are in `shell-startup-phases.json`, `wasm-copy-patch-proof.json` and
`shell-optimizer-experiment.json` under `artifacts/results`.
