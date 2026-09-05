# Smaller core: measured against direct Node

The core artifact is now **16.6 MB instead of 53.6 MB**, a 69% reduction. Fixing
the login-shell probe removes a 15-second stall. With the tested Linux glibc
allocator settings, idle process-tree memory is roughly half the earlier
configuration. The same reduced core still runs faster and uses less idle
memory directly on Node; this work does not establish Node parity.

## Workload and comparison

Each run uses the pinned OpenClaw 2026.8.1 core, real `read` and shell `exec`
tools, three deterministic inference calls per turn, real transcript commits,
and five warm continuation turns. No model network latency is included.

PSS below includes the Node host and all native sidecar processes. Values are
MiB, not the guest heap limit. All sampled RSS/PSS and event timestamps are in
`artifacts/results/benchmark-*.json`; `benchmark-summary.json` aggregates them.

| Configuration | Launch → first result | Warm-turn run medians | Idle PSS | Peak PSS |
| --- | ---: | ---: | ---: | ---: |
| Previous agentOS, full artifact, 5 runs | 19.88–26.29 s | 321–387 ms | 1,040–1,130 | 1,125–1,221 |
| Reduced agentOS, default allocator, 1 run | 4.44 s | 304 ms | 816 | 907 |
| Reduced agentOS, compact allocator, 4 runs | 4.06–4.42 s | 297–329 ms | 514–549 | 619–658 |
| Published worker on Node, default allocator, 2 runs | 2.07–2.14 s | 30–36 ms | 572 | 979–986 |
| Published worker on Node, compact allocator, 1 run | 1.93 s | 30 ms | 499 | 897 |
| Same reduced core on Node, compact allocator, 3 runs | 1.00–1.22 s | 26–29 ms | 273 | 575–686 |
| Two reduced agentOS instances, compact allocator, 1 run | 4.87–4.98 s per instance | 405 ms pooled | 901 total | 1,123 total |

The main optimized rows use agentOS trials 15–18 and native-core trials 2–4.
Two-instance trial 3 uses independent sidecar pools and SQL services. Trial 18
and native-core trial 4 verify the final build with restored upstream license
notices. Final-build checks measured 4.31 s / 518 MiB idle for agentOS and
1.22 s / 273 MiB idle for Node; raw reports include their exact hashes.
The earlier untuned native-core trial 1 ran alongside a correctness test and is
excluded from the main comparison.

The compact allocator settings are applied equally to the Node baseline and
the agentOS host/sidecars. Comparing optimized agentOS only against the old,
large Node artifact would hide the remaining gap: the reduced Node core needs
about half the idle memory, roughly a quarter of the cold latency, and roughly
a tenth of the warm latency. Memory is much closer to the original Node worker,
but the reduced Node core is the stronger target.

Launch timing excludes compilation, VM creation and staging. Node timing starts
at OS process creation; agentOS timing starts at submission of the staged entry.
Fresh storage is used for each run, but host file caches are not flushed. These
are small local samples on shared Linux infrastructure, not p95s, production
capacity tests, cloud billing estimates or Cloudflare deployment results.

## Changes that produced the gains

### 1. Repair the exact login-shell probe

Targeted timing in trial 11 measures `getShellPathFromLoginShell()` at **15,007
ms** on its first call. The default agentOS shell's `env -0` does not complete
within the timeout. `printenv -0` returns the required NUL-delimited environment.
The child-process adapter matches only OpenClaw's exact `/bin/sh` login probe
and substitutes the environment-print command. It retains the login flags,
startup files, NUL sentinel, options and real process errors.

The regression checks verify Buffer output, NUL boundaries, a multiline value
containing `=`, a real shell PATH, and the exit status of an unrelated failing
command. We did not lower the timeout, return a fabricated environment or skip
command parsing. This adapter covers the default `/bin/sh` probe; it does not
claim to repair every shell or agentOS's `env` utility globally.

Shell-only trial 12 used the full artifact and completed its first core turn
in 3.28 seconds after worker-ready, versus about 18 seconds before the fix.
Its launch-to-first-result was 5.72 seconds. That isolates the timeout fix from
the later size and allocator changes.

### 2. Build an explicit, pinned core profile

`core-profile.mjs` and `slice-core-artifact.mjs` operate on the verified published
worker. They leave installed packages and reference source untouched. They:

- Reject an unreviewed input SHA-256.
- Replace two disabled lazy boundaries with explicit unsupported errors:
  gateway compaction runtime and source extension transformation. The existing
  embedded worker sets compaction disabled and `noExtensions: true`.
- Trace lexical references from the existing embedded initializer and turn
  function, splitting merged variable declarations and comma-separated eager
  calls so unrelated modules can be removed.
- Preserve selected declaration text, source order, eager calls to retained
  initializers and standalone runtime registration. Retain legal notices.
- Remove the worker CLI entry, then apply the existing import adapters and
  async lowering. There are ten retained import rewrites and two retained
  native async-iterator intrinsic replacements.

The final native core is **14,597,354 bytes**, and the lowered guest core is
**16,598,563 bytes**. Input remains 46,593,544 bytes. The manifest records sizes,
hashes, removed boundaries, retained unit counts and adapter/compiler details.

The first slicer attempt missed eager initialization before channel metadata
use. The corrected transformation preserves those calls, and a focused
regression checks eager ordering, local destructuring versus property labels,
legal notices and changed-boundary rejection. Full integration tests pass.
This is a pinned artifact transformation, not a general-purpose proof of dead
code elimination. Arbitrary dynamic code, browser/channel paths and extension
loading are outside the validated core profile. The active agent loop, coding
tools, permission checks, real command parser, transcript commits and terminal
ordering remain upstream implementations.

`CORE_PROFILE=full npm run core:build` retains the full control. Use the default
`npm run core:build` for the reduced profile. This is still an artifact patch,
even though neither upstream source repository is forked.

### 3. Reduce allocator retention through launch configuration

The compact Linux/glibc profile sets these before starting the host:

```sh
MALLOC_ARENA_MAX=1
MALLOC_TRIM_THRESHOLD_=65536
MALLOC_MMAP_THRESHOLD_=65536
```

The benchmark applies these to the measured subprocess and inherited sidecars;
it does not alter the runtime binary. Trial 13 measured 816 MiB idle with the
reduced artifact and defaults. Trial 14, an intermediate two-arena/128 KiB trim
experiment, measured 559 MiB. Trials 15–18 use the one-arena/64 KiB configuration.
The sampler now records the effective allocator environment explicitly.

For representative trial 16, PSS was 222 MiB after empty-VM provisioning,
241 MiB after staging, 529 MiB idle, 364 MiB after VM disposal/outer-host GC,
and 80 MiB after explicit sidecar disposal. The complete lifecycle accumulated
about 10.6 sampled CPU-seconds, versus roughly 32 in the earlier representative
full configuration. This includes six turns, calibration and lifecycle work;
it is not billable CPU.

Allocator settings have workload-dependent throughput tradeoffs. The two-instance
run passed, but a high-concurrency host requires its own validation. The ordinary
core test leaves allocator defaults intact; `test:core:compact` opts in.

## Remaining limits and rejected approaches

After the timeout fix, SQLite transport is a material remaining cold-turn cost.
Trial 16 made **3,306 cold-turn binding calls**, taking **2.17 seconds** in the
guest adapter versus **0.22 seconds** inside the host SQL handler. The whole cold
turn after ready took 3.62 seconds. Warm turns amortize schema initialization,
but guest shell/process and filesystem boundaries remain slower than Node.
No schema, integrity check or authorization check was removed to reduce calls.

The diagnostic trail is retained rather than silently mixed with final runs:

| Experiment | Outcome |
| --- | --- |
| Bundle the published embedded-runtime chunk directly | Still pulls thousands of modules plus external packages; rejected |
| Ordinary tree shaking / identifier minification | Insufficient reduction; not adopted |
| Trials 6–7: replace apparently slow async `lstat` with a synchronous delegate | No cold-turn improvement; reverted |
| Trials 8–11: targeted runtime timing | Session setup and parser initialization are short; the login-shell probe accounts for the 15-second gap |
| Trial 10: tree-sitter parser loading / command parsing | About 87 / 95 ms initially; actual process spawn about 23 ms |
| Trial 12: shell fix alone | Cold-turn improvement confirmed with full artifact |
| Trial 13: reduced profile, allocator defaults | Size/launch gain confirmed; idle memory still 816 MiB |
| Trials 14–17: allocator experiments and repeats | Further memory reduction without changing core algorithms |

The guest inspector API is a stub, so these are targeted elapsed-time probes,
not a CPU flame graph. In particular, async filesystem elapsed time included
waiting for other work; it was not evidence of filesystem CPU cost.

Shared-sidecar host-binding replacement remains unresolved in published agentOS
0.2.19. The separate binding probe still rejects shared modes and passes separate
pool routing plus foreign-binding rejection. Keep a dedicated pool per active
core environment and dispose its sidecar on eviction. Merely disposing the VM
leaves resident allocations. The [baseline report](runtime-benchmark-baseline.md)
preserves the routing investigation and failed shared-sidecar control.

No containers, OpenClaw source fork, agentOS source changes, Rust build, Gateway
implementation, GitHub upload or Cloudflare deployment were introduced. The
result is a substantially improved local core prototype, with a measured and
still significant advantage for direct Node on the equivalent reduced core.

## Reproduce

Use the pinned dependencies, Node 24 and Linux/glibc described in the README:

```sh
npm run core:build
npm run test:core:compact
npm run test:core-profile
npm run probe:async-context
npm run probe:bindings
npm run test:host-sqlite
npm run core:report
npm run bench:build
npm run bench:core -- --instances 1 --allocator compact --trial 20
npm run bench:core -- --instances 2 --allocator compact --trial 20
npm run bench:core -- --native --core --allocator compact --trial 20
npm run bench:core -- --native --allocator compact --trial 20
npm run bench:report
```

Profiling controls are `BENCH_PROFILE_CORE=1`, `BENCH_PROFILE_FS=1` and
`BENCH_SPLIT_INIT=1`. Do not pool instrumented runs with performance runs.
The sampler reads the Linux process tree every 100 ms, rejects zero-memory
measurement failures, accounts for PID namespaces, and retains raw samples.
PSS prorates shared pages; summed RSS can double-count shared mappings. Short
peaks may fall between samples. Test tools assert actual outputs, exit statuses,
transcript lengths and terminal completion before a run is counted as passing.
