# Where the agentOS / Node gap comes from

The tested JavaScript computation is already near direct-Node speed. The large
OpenClaw gap appears when the turn performs filesystem operations and invokes
shell commands. This is evidence for specific runtime-boundary costs, not a
claim that every JavaScript workload has parity.

## Actual OpenClaw turns

Each row executes one cold and 50 warm turns on both runtimes, with identical
inference responses, tool selection, output checks and transcript expectations
within the row. Core-shell uses read then exec. Core-read-ready keeps both read
and exec available but invokes only read. Core-none invokes no tools.

| Workload | agentOS warm median | Node warm median | agentOS CPU across 50 warm turns | Node CPU across 50 warm turns |
| --- | ---: | ---: | ---: | ---: |
| No tools | 25 ms | 3.9 ms | 1.63 CPU-s | 0.43 CPU-s |
| Read, with exec available | 41 ms | 8.8 ms | 2.50 CPU-s | 0.63 CPU-s |
| Read plus shell exec | 338 ms | 27.1 ms | 24.75 CPU-s | 2.09 CPU-s |

Matched runs are agentOS **47, 51, 48** and native-core **9, 15, 10**. These are
one 50-turn run per cell, not independent repetitions of 50 cold processes.
Transcript lengths are 102, 204 and 306 messages respectively. The simpler
read-only tool configuration (46/native-core-8) gives similar 40/8.4 ms warm
medians. Making exec available by itself did not impose the large shell cost.

Cold agentOS turns with no actual exec make only **8 SQLite binding calls**;
the first actual exec turn makes **1,700**. Read-ready reaches its first result
about **1.07 s after launch**, while core-shell takes **3.66 s** in this pass.
The corresponding Node results are about 0.80 and 1.24 s. Thus the expensive
cold schema/state setup is associated with first execution, not every basic
conversation or tool registration.

Across 50 warm turns, core-shell makes 1,100 SQL calls with only 59 ms spent in
host SQLite. Read-ready makes no warm SQL calls. The existing schema batching
helps the first exec, but cannot account for the multi-second warm CPU gap.

The cross-row CPU difference includes an additional tool result, inference
response, process bookkeeping and transcript growth. It is not an exact
subtraction of shell-only CPU. These workload variants are diagnostics, not
replacement implementations that remove features from the normal runtime.

## Primitive boundary checks

These bypass the OpenClaw turn while loading the same reduced worker artifact.
Output, exit code and stderr are checked for every process; all commands produce
the same 15-byte seed. JS computation has a checked 32-bit checksum. Direct
commands use `spawn` with `shell:false`; shell cases use a real `/bin/sh -c`.

| Primitive, warm mean per operation | agentOS | Direct Node |
| --- | ---: | ---: |
| JavaScript: 25 million xorshift iterations | 42.3–43.4 ms | 42.5–44.9 ms |
| Read 15-byte file, durable workspace mount | 0.86–0.89 ms | 0.003–0.004 ms |
| Read 15-byte file, ephemeral root filesystem | 0.56 ms | 0.003 ms |
| Direct `cat` | 77.6–81.4 ms | 2.4–2.5 ms |
| Shell running `cat` | 224.5–233.6 ms | 2.9–3.4 ms |
| Shell builtin `printf` | 137.4–144.3 ms | 2.0–2.6 ms |
| Tiny Node child reading the file | 32.8–34.9 ms | 56.9–58.6 ms |

For JS, each warm batch contains 20 operations (500 million iterations total).
Reads use 5,000 operations and process cases use 30. AgentOS runs **49, 50, 52**
and native-core runs **11, 12, 14** provide the ranges. Runs 50 and 12 reverse
case order; 52 and 14 add the root-filesystem comparison. The root comparison
has one run per runtime. Initial operations are recorded separately from warm
batches, and no initial outlier is silently removed from a warm batch.

The JS batch consumes about **0.81–0.90 CPU-s on agentOS** and **0.80–0.90 on
Node**. Thirty shell-cat operations consume **11.04–11.32 CPU-s on agentOS**,
versus roughly **0.11–0.12 on Node**. Thirty tiny Node children consume
**0.81–0.88 CPU-s on agentOS**, versus **1.94–2.04 on Node**. The cheap guest Node
child is a meaningful counterexample to the idea that all process creation is
slow in agentOS; it does not establish full Node API compatibility.

The shell-builtin result shows a large cost even without an external `cat`.
The direct-cat result shows an additional cost without a shell. These intervals
still include runtime setup, command execution and event delivery. They do not
separate WASM compilation from scheduling or isolate lifecycle work. Adding
independent primitive timings is not an exact model of a nested shell command.

Changing the file to the ephemeral root reduces read cost but leaves it far
above native reads. Durable chunked-local storage contributes to the gap, while
it is not the whole explanation. The runtime continues using durable mounts.

## Read-turn filesystem profile

Diagnostic run **53** profiles five warm read-ready turns. Each turn records
12 synchronous lstat calls, 18 promise lstat calls, eight synchronous realpaths,
eight promise realpaths, five promise stats and four synchronous writes, among
other operations. Some wrappers can nest; these counts are not a count of
unique kernel operations, and their elapsed times must not simply be summed.

This supports investigating repeated path resolution and file validation in
addition to shell execution. It does not justify caching validation across
mutations or skipping symlink/containment checks. The normal core code and
filesystem adapter are unchanged by this diagnostic pass.

## CPU measurement correction

The sampler now records both each live process's own CPU and its CPU accounting
for reaped children. Summing live processes plus their reaped-child CPU avoids
missing native children that complete between 100 ms samples. A monotonic
high-water mark limits regressions during exit/reap races. These figures are
still sampled approximations; very short native file/command phases can be
below resolution. A reported zero for such a phase does not mean zero CPU.

Phase boundaries align the recorded monotonic event timestamps with the
sampler clock using the minimum receive offset. Using stdout receipt time alone
misattributes CPU when Node buffers a marker before a synchronous computation.
Native-core-12 provides an observed example; its JS CPU is about 0.90 s after
alignment, rather than incorrectly assigning that work to the preceding read.

Guest core-turn CPU includes checkpoint transport. Primitive warm batches use
only one start and one end checkpoint for the whole batch. Latency is measured
inside the fixture, excluding marker transmission. The process-tree includes
the Node host and sidecar; native short-child CPU is now included as described.

Runs **45/native-core-7** precede child accounting and are exploratory. Native
**13** failed with EAGAIN during an attempted synchronous stdout marker write;
it is retained and excluded. The experiment was reverted; timestamp alignment
handles buffered console output. Run **53** is instrumentation-only and excluded
from uninstrumented latency ranges. Failed runs are not used as comparators.
The sampler now requires completion checkpoints as well as successful exit.

## Engineering consequence

An OpenClaw fork is not supported as the next step by this evidence. The tested
JS calculation needs no rescue; shell/process execution and many small VFS
operations need attention. The useful investigations are:

1. Preserve path safety while reducing repeated file validation/read crossings,
   or evaluate a published filesystem backend with equivalent durability and
   isolation. A cache must handle writes, renames and symlink changes correctly.
2. Seek improvements in the published shell/command runtime. The primitive
   fixture is a reproducible case for upstream; no binary change was attempted.
3. A separate structured argv tool could exploit the cheaper direct path for
   suitable commands, with the real shell still available. It would be a new
   capability with different semantics, not a transparent shell-string rewrite.

The normal read-plus-exec benchmark remains intact. No gateway, containers,
OpenClaw fork, agentOS fork, native host exec bypass or cloud deployment was
introduced. Native-like computation is demonstrated; full-flow parity is not.

## Reproduce

```sh
npm run bench:build
BENCH_WORKLOAD=boundaries AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 70
BENCH_WORKLOAD=boundaries BENCH_REVERSE=1 python3 scripts/benchmark/measure.py --native --core --allocator compact --trial 70
BENCH_WORKLOAD=core-read-ready BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 71
BENCH_WORKLOAD=core-read-ready BENCH_WARM_TURNS=50 python3 scripts/benchmark/measure.py --native --core --allocator compact --trial 71
python3 scripts/benchmark/bottlenecks.py
python3 scripts/benchmark/summarize.py
```

Use `core-none`, `core-read`, or `core-shell` for the other turn variants.
Use unused trial numbers. Artifact compilation is outside the measured process;
all runs use local deterministic inference and warm host file caches.
