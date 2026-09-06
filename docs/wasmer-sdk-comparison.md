# Wasmer SDK comparison

This experiment uses the published `@wasmer/sdk@0.11.0` Node entrypoint with
`wasmer/edgejs@0.2.0`, its bundled shell, and core utilities. The trusted,
reduced OpenClaw core runs in the host Node process. Real OpenClaw read, write,
edit, and exec tools use Wasmer's filesystem/process APIs through the same
interfaces used by the agentOS hybrid experiment. No tool command falls back
to the host shell.

This tests Wasmer as a tool sandbox, not the complete OpenClaw core inside
Wasmer. The gateway, channels, real LLM requests, concurrent tenants, and
production workloads remain excluded. See [the representative fixture](representative-workload.md)
for the workload: 21 turns, five tool calls per turn, two child JavaScript
programs per turn, a 1 MiB catalog, 48 source files, streamed responses, and
history growing to approximately 1 MiB.

## Results

All six clean trials passed every required turn/checkpoint and result assertion.
Values are medians across two runs (warm latency is the median of each run's
20 warm-turn durations); peaks are the observed range. RAM is MiB of PSS.

| Tool backend | Active median RAM | Retained idle RAM | Peak RAM range | CPU for 20 warm turns (s) | Warm turn (ms) |
|---|---:|---:|---:|---:|---:|
| Native | 191.0 | 205.2 | 516–680 | 6.00 | 683.6 |
| agentOS | 304.4 | 304.8 | 862–878 | 21.50 | 1334.4 |
| Wasmer SDK | 1828.4 | 2791.3 | 2779–2806 | 34.83 | 1963.5 |

On this fixture, Wasmer uses 6.0× the active median RAM, 9.2× the retained idle
RAM, and 1.62× the warm-turn CPU of the optimized agentOS hybrid. Warm turns
are approximately 47% slower. Direct Node remains smaller and faster than both.

Wasmer memory rises through the session. In clean trial 1102, nearest-checkpoint
PSS was 595 MiB after turn 1, 1259 MiB after turn 6, 1847 MiB after turn 11,
and 2802 MiB after turn 21. It stays near that level during the 1.5-second idle
window. Trial 1103 reproduces the roughly 2.7 GiB endpoint. Worker-thread count
is approximately stable during the warm phase; these observations do not locate
the retained allocations or establish an unbounded leak.

This version/configuration is not an improvement for the current RAM goal.
Keep direct Node as the efficiency baseline and agentOS as the tested sandbox
option. A future Wasmer comparison would need to address this retention and
revalidate the workload. These are two-run experiments, not a 4 GiB production
capacity estimate or a verdict on native Wasmer, other guest runtimes, or other
SDK versions. Destroying the entire host process per request would reclaim its
memory, but this test does not quantify that deployment's repeated startup cost.

Clean native trials: 1101/1102; agentOS and Wasmer: 1102/1103. Raw samples and
summary are in `artifacts/results/wasmer-sdk-comparison.json` and its listed files.
Generate the retained summary with:

```sh
python3 scripts/benchmark/summarize.py --trials 1101 1102 1103 --output wasmer-sdk-comparison.json
```

## Method

Two clean trials per backend, sequentially, on two Linux CPUs. Every host uses
Node 24.19.0, `--max-semi-space-size=8`, and the same 32 KiB glibc allocator
profile. Whole-process-tree PSS and CPU are sampled every 100 ms; Node worker
threads are included in their process's accounting. CPU is CPU-seconds across
the 20 warm turns, including reaped child processes, not wall time or CPU percent.
Each turn contains 420 ms of identical scripted response waits.

Package downloads are prewarmed outside the measurements. SDK initialization,
Wasm compilation, tool execution, and cleanup run inside the measured process.
The Wasmer cache holds approximately 81 MiB of packages on disk; this is not a
RAM measurement. The exact downloaded package versions and verified SHA-256
hashes are in `artifacts/results/wasmer-package-manifest.json`. Registry dependency
resolution may change; compare those hashes when reproducing.

Wasmer uses an in-memory workspace; agentOS uses its `chunked_local` disk-backed
workspace; native uses the host filesystem. Bootstrap, configuration, SQLite,
and transcript storage remain native for all three. These are different
isolation/persistence mechanisms, not interchangeable security boundaries.
agentOS retains its existing resource limits; the Wasmer adapter does not claim
equivalent hard heap, process, filesystem, or tenant limits.

## Compatibility findings

- The SDK filesystem API's root maps to guest `/workspace`; the adapter converts
  paths accordingly. Read/write/edit and shell see the same guest files.
- Edge.js reports `v24.13.2` and executes both dependency-free Node-style programs
  in this fixture. This does not establish full Node/OpenClaw compatibility.
- Edge.js needs `--experimental-wasm-jspi` on this host Node. Without it, a worker
  panics because the host lacks WebAssembly JSPI. The benchmark enables the flag
  only for Wasmer, including its inherited worker arguments.
- SDK `spawn({timeoutMs})` alone allowed `sleep 5` to finish after about five
  seconds despite a one-second timeout. The adapter adds a host timer and calls
  `Process.kill()`. The separate real-tool correctness probe verifies timeout,
  output/exit status, read/write/edit, guest-only files, and denied outside paths.
- PTY/background-session behavior and production isolation are not validated.

The SDK uses Wasmer/WASIX compiled to WebAssembly inside JavaScript, with Node
workers; it is not a native Wasmer addon. See the
[official SDK documentation](https://github.com/wasmerio/wasmer-sdk/tree/main/js).
The observed retained-memory growth is not by itself a diagnosis of a leak or
proof that any particular layer causes it.

## Reproduce

```sh
pnpm install --frozen-lockfile
npm run core:build
npm run bench:build
npm run bench:wasmer:prewarm
npm run test:wasmer
export BENCH_WORKLOAD=core-workload BENCH_WARM_TURNS=20 BENCH_IDLE_MS=1500
export AGENTOS_V8_WARM_ISOLATES=0
export MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=32768 MALLOC_MMAP_THRESHOLD_=32768 MALLOC_TOP_PAD_=0
python3 scripts/benchmark/measure.py --native --core --wasmer --node-semi-space-mb 8 --cpus 2 --trial 1201
python3 scripts/benchmark/measure.py --native --core --hybrid --node-semi-space-mb 8 --cpus 2 --trial 1201
python3 scripts/benchmark/measure.py --native --core --node-semi-space-mb 8 --cpus 2 --trial 1201
```

Use `NODE_USE_ENV_PROXY=1` if your Node package downloads require the configured
HTTP proxy. Repeat in reverse order with fresh trial numbers. Do not run other
experiments concurrently. `WASMER_CACHE_DIR` overrides the default
`/tmp/openclaw-wasmer-cache`; use the same directory for prewarming and trials.

The exploratory two-turn run is trial 1100. The initial Wasmer/agentOS trial
1101 files are under `artifacts/results/wasmer-exploratory/`, excluded from the
final comparison because an earlier idle diagnostic may have overlapped them.
