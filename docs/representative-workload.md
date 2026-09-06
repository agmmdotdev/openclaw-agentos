# Representative single-agent workload

This benchmark exercises a heavier coding workflow through the real OpenClaw
core. Model decisions and response delays remain synthetic and deterministic;
these results are not a production memory or concurrency guarantee.

## Work performed

The same fixture runs on native Node, on the hybrid's trusted native core with
agentOS tools, and inside the guest core. It seeds:

- 48 source text files of 16 KiB each (768 KiB total).
- A 1 MiB catalog with 8,192 fixed-width records.
- A roughly 4 KiB configuration file and two small JavaScript project scripts.
- 24 prior messages, approximately 100 KiB of serialized conversation history.

Each of 21 turns performs five real tool calls:

1. Read the configuration through OpenClaw's `read` tool.
2. Execute a project script that reads all 48 files and searches for TASK lines.
3. Edit the configuration version through OpenClaw's `edit` tool.
4. Write an 8 KiB report through OpenClaw's `write` tool.
5. Execute a second project script that validates the version, report, and
   catalog size, then returns 16 KiB of catalog data and a success marker.

The project scripts run as child Node processes: native children in the native
control and agentOS guest JavaScript processes in both agentOS configurations.
This includes actual command execution and file I/O, not mocked tool results.

Inference waits 60 ms before each of six responses per turn. Final replies are
2 KiB, delivered in four text deltas with 15 ms pauses. There is a 100 ms gap
between turns. These brief fixed pauses exercise waiting and streamed-event
paths; they are not calibrated to a provider's timing. Turn latency includes
420 ms of configured response waits, and CPU is measured separately.

Transcript commits append to a JSONL log. At each turn boundary the complete
history is checkpointed and reloaded from disk for the next turn. Each full
run completes 105 tool calls, produces 84 scripted text deltas, and finishes
with 276 messages and approximately 1 MiB of serialized history. This tests
continuation in one process; it does not test worker/VM restart recovery.

Assertions check search results from the first and last source files, catalog
records 0 and 127 and the script's success marker, exit codes, exact persisted
configuration and report contents, transcript counts, and terminal completion.
The outer sampler also requires a completion checkpoint for every turn.

## A compatibility gap found during setup

The published default agentOS environment has no `grep` command: the original
search command exited 127. The retained diagnostic
`benchmark-hybrid-native-core-1003.json` records this failure. The measured
fixture instead uses the same dependency-free JavaScript search script in all
three architectures. This does not add grep support or establish compatibility
with arbitrary shell utilities. It does exercise real repository searching.

The short native, hybrid, and guest runs all passed before full measurements.

## Comparison method

OpenClaw 2026.8.1, agentOS 0.2.19, Node 24.19.0. One cold turn plus 20 warm
turns per run, with two runs per configuration and reversed order. All runs
are serial with affinity restricted to two allowed Linux CPUs. They share the
32 KiB glibc memory allocator profile, one arena, zero top pad, and zero warm
agentOS isolates. Guest writable storage is chunked_local; its code is on a
read-only host_dir mount. Native/hybrid core configuration and transcript
storage stay on the host, as in the earlier hybrid experiment.

The hybrid control uses the default host semi-space. The selected hybrid and
native control use an 8 MiB host semi-space cap. The guest retains its existing
256 MiB guest heap; this experiment does not alter guest heap limits.

PSS includes the host and all descendants, sampled every 100 ms. Active RAM is
the median from cold-turn start through the last warm-turn completion, including
response waits and between-turn gaps. Post-workload idle is the median during
the following 1.5 seconds. Table values average the two per-run medians; CPU
averages the sampled CPU for the 20 warm turns, including reaped children.
Peak ranges show each run's sampled maximum across the entire lifecycle,
including setup. Short spikes may be missed.

The sampler retains hashes of the fixture, builder, hybrid adapter, and generated
entries. Diagnostics and forced garbage collection are disabled. Historical
startup fields have different phase boundaries across harnesses, so this report
does not compare those fields as equivalent cold-start measurements.

| Architecture | Active median PSS MiB | Post-workload idle PSS MiB | Warm turn ms | Warm CPU seconds | Peak PSS range MiB |
|---|---:|---:|---:|---:|---:|
| Guest core, memory profile | 408.2 | 424.3 | 1804.2 | 39.10 | 544–549 |
| Hybrid, default host heap | 401.1 | 406.6 | 1319.9 | 21.57 | 842–903 |
| Hybrid, 8 MiB semi-space | 304.5 | 311.4 | 1315.4 | 20.88 | 772–847 |
| Native core/tools, 8 MiB semi-space | 192.1 | 207.1 | 668.9 | 5.71 | 549–670 |

## Interpretation and limits

The selected semi-space profile still reduces hybrid RAM on this larger test:
active median PSS falls 24.1% (401.1 to 304.5 MiB) and retained idle PSS falls
23.4% (406.6 to 311.4 MiB). Warm median latency is essentially unchanged; the
3.2% lower sampled CPU in this small pair is not a reliable speedup claim.

The optimized hybrid uses less working/retained RAM than the guest core on this
workload and completes its warm turns faster, but its transient peak is larger.
Fully native remains the smallest and fastest configuration here, with a
different tool-execution boundary. Keeping the 8 MiB setting opt-in is supported
by these results. None of these measurements fixes the outstanding peak-RAM
problem.

Active median can be lower than post-workload idle: memory grows as history
accumulates, and the active median spans earlier smaller turns. Idle does not
imply all retained pages were returned to the operating system.

This fixture is intentionally more demanding than the old tiny-file read+cat
loop. Its longer waits, 21 rather than 51 turns, different history, additional
child processes, and allocator settings mean the two workloads must not be
compared as an isolated optimization experiment. Compare configurations within
this report. Two trials are not sufficient for production capacity planning.

It still excludes real provider requests, realistic model-token accounting,
unpredictable model decisions, package installation, dependency-heavy builds,
large binaries/images, gateway/channels, concurrent tenants, and prolonged
background jobs. The generated source is text, and the validation script is a
small dependency-free program. It is a reproducible representative test, not
an actual customer application or a complete OpenClaw compatibility suite.

## Reproduce

Build first, outside the measured process:

```sh
npm run core:build
npm run bench:build
export BENCH_WORKLOAD=core-workload BENCH_WARM_TURNS=20 BENCH_IDLE_MS=1500
export BENCH_CORE_MOUNT=host_dir AGENTOS_V8_WARM_ISOLATES=0
export MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=32768 MALLOC_MMAP_THRESHOLD_=32768 MALLOC_TOP_PAD_=0
# Guest core
python3 scripts/benchmark/measure.py --cpus 2 --trial 1011
# Native core and native tools
python3 scripts/benchmark/measure.py --native --core --node-semi-space-mb 8 --cpus 2 --trial 1011
# Hybrid control
python3 scripts/benchmark/measure.py --native --core --hybrid --cpus 2 --trial 1011
# Hybrid with the selected Node profile
python3 scripts/benchmark/measure.py --native --core --hybrid --node-semi-space-mb 8 --cpus 2 --trial 1012
```

Use fresh trial numbers if these files already exist. Repeat in reverse order;
the retained second trials are 1013 for the selected hybrid and 1014 for the
other three configurations. Avoid overlapping measurements with other tests.
The default benchmark workload remains the original read+cat loop.

```sh
python3 scripts/benchmark/summarize.py --trials 1011 1012 1013 1014 --output representative-comparison.json
```
