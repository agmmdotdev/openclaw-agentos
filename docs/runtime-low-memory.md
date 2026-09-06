# Optional lower-RAM profile

The new memory profile reduces retained process-tree memory after the same
OpenClaw workload by about **80 MiB (17%)**, with an observed **12% warm CPU
cost** and **14% higher warm-turn median latency**. It is opt-in; the existing
economy profile remains unchanged.

## Repeated measurements

Controls are runs 112 and 116; memory-profile runs are 115 and 117. Each runs
one cold and 50 warm read-plus-shell turns, with deterministic inference,
306 transcript messages, the same 256 MiB guest heap, read-only core mount,
durable chunked_local workspace/state and separate sidecar pool. SQL statement
reuse stays disabled. Compilation and tests do not overlap measurement.

Values below average two run-level measurements per profile. Warm latency is
the mean of run medians. This is a small local repeat experiment, not a
production capacity or high-concurrency result.

| Measurement | Economy | Memory profile |
| --- | ---: | ---: |
| First 1.5 seconds of idle: process-tree PSS | 464.9 MiB | 385.5 MiB |
| Range across the two runs | 460.0–469.8 MiB | 384.3–386.6 MiB |
| Sampled peak process-tree PSS | 572.5 MiB | 551.5 MiB |
| CPU across 50 warm turns | 24.54 CPU-s | 27.58 CPU-s |
| Mean warm-turn median | 325.75 ms | 372.75 ms |

Peak memory only falls about 4% on average and is more variable. The strongest
result is retained memory immediately after the repeated workload, not a large
reduction in the highest startup allocation. These figures include the Node
host and the agentOS sidecar. They are PSS, not virtual-address reservations.
No new direct-Node comparison was run in this pass.

The [comparison JSON](../artifacts/results/idle-memory-comparison.json) retains
per-run metrics and the exact environment; all six raw runs are kept. Regenerate:

```sh
python3 scripts/benchmark/summarize.py --trials 112 113 114 115 116 117 --output idle-memory-comparison.json
```

## Idle duration matters

The previous benchmark waited only 1.5 seconds before exiting the guest. Runs
112 and 117 instead hold the same loaded guest idle for 30 seconds. In the
last five seconds, economy memory is 416.3 MiB versus 367.1 MiB with the memory
profile. This is one longer-idle run per profile, not repeated distributions.

Within the economy run, the sidecar drops from about 365 to 322 MiB while the
host remains around 95 MiB. Idle runtime reclamation therefore releases some
memory without unloading the worker. The 80 MiB comparison above deliberately
uses the **same first 1.5-second window** in all four runs; comparing a long-idle
median against a short-idle median would overstate the improvement.

The benchmark accepts `BENCH_IDLE_MS` between 1,500 and 60,000 and reports
`earlyIdlePssMiB`, `lateIdlePssMiB` and the full-idle median separately. Its
default remains 1,500 ms.

## What changes

`coreMemoryEnvironment()` builds on the version-checked Linux/glibc economy
environment and changes only these launch settings:

```sh
MALLOC_TRIM_THRESHOLD_=32768
MALLOC_MMAP_THRESHOLD_=32768
MALLOC_TOP_PAD_=0
```

`MALLOC_ARENA_MAX=1` and `AGENTOS_V8_WARM_ISOLATES=0` are retained. The profile
does not disable glibc's thread cache. Custom caller-supplied glibc tunables are
inherited and can change behavior; the measured runs had none set.

This asks glibc to return free memory more aggressively and use independent
mappings for smaller eligible allocations. The implementation does not alter
OpenClaw's source, the published agentOS 0.2.19 binary, guest heap limits, shell
tools, permissions, persistence or inference behavior. It is allocator tuning,
not a smaller maximum allowed workload. The same compatibility limits apply.

The new launcher uses `process.execve`, like the economy launcher, so it leaves
no extra Node process resident. It inherits the existing pinned-runtime and
Linux/glibc checks.

```sh
npm run test:core:memory
# Launch a custom core host with the same environment:
node scripts/run-core-memory.mjs your-core-host.mjs
```

The full memory-profile core gate passes capabilities, write/read/edit/exec and
apply-patch, failure/background scenarios, continuation and VM restoration.
The [separate probe report](../artifacts/results/core-probe-memory.json)
records all three successful generations and the actual launch environment.
`CORE_PROBE_REPORT` lets a probe retain a separate output file; ordinary probe
defaults stay unchanged.

## Other settings tested

- Run 113 used 16 KiB thresholds, zero top pad and disabled glibc thread caches.
  It retained 405.5 MiB with 29.63 CPU-s across 50 warm turns; not selected.
- Run 114 retained thread caches with 16 KiB thresholds and zero top pad.
  It retained 393.9 MiB with 27.59 CPU-s. The 32 KiB candidate had similar CPU
  and lower observed retained memory, and was selected for a repeat.
- The earlier 128 MiB guest-heap test did not establish an actual RAM saving.
  This pass keeps the heap at 256 MiB.

Further savings for inactive tenants can come from ending the guest and
disposing both the VM and its dedicated sidecar, then recreating them from
durable state. Existing restoration checks cover that lifecycle, but it has a
reload cost and needs to account for outstanding work. This pass does not add
an automatic idle-eviction policy.
