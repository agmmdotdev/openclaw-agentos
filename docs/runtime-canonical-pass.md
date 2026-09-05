# Optional canonical table batching

The new batch reduces cold startup work, but repeated tests show a small warm
CPU and memory penalty. It is disabled by default in the probe and benchmark harnesses. The previous table and named
index batches remain enabled. No runtime binary, upstream source checkout,
shell behavior, gateway or channel implementation is changed.

## Boundary and correctness

The build verifies the pinned OpenClaw 2026.8.1 worker hash and exact function
anchors, then extracts the read-only statements from
`readCanonicalStrictTables()` into the verified host collector. The original
guest function still opens and configures its connection, executes the schema,
and closes the connection in `finally`. Only the metadata scan crosses the
binding once. The host operation requires an existing authorized database
handle; it opens no connections and caches no schema results.

The extracted collector is 15,166 bytes, with SHA-256
`9332ebdb5f95cb07092629b46eeb884f1a124e3f6a2b18052e9c7bacdd378d17`.
Original rowid aliases and their initialization are retained. Unit and actual
guest differential checks cover Unicode ordering, generated columns, integer
and composite primary keys, WITHOUT ROWID, descending primary keys, shadowed
rowid aliases, non-STRICT rejection, transaction changes and rollback. Unknown
and foreign database handles remain rejected.

## Three runs per configuration

All six runs use published agentOS 0.2.19, Node 24.19.0, the economy environment,
the shared read-only core mount, and one cold plus 50 warm real core turns.
Every turn executes the same read and shell flow with deterministic inference.
All runs pass: 306 transcript messages and three inference calls per turn.
Runs are serialized, with configuration order control/batch/batch/control/
batch/control. Values below are arithmetic means across runs; warm latency is
the mean of each run's median. Memory is sampled process-tree PSS including
host and sidecar, and CPU accounting includes reaped children.

| Metric | Previous batch | Canonical batch |
| --- | ---: | ---: |
| Cold SQLite binding calls | 1,373 | 961 |
| Launch to first result | 3,360 ms | 2,898 ms |
| Cold-turn CPU | 4.683 CPU-s | 4.037 CPU-s |
| 50 warm turns CPU | 24.060 CPU-s | 24.990 CPU-s |
| Warm turn median | 324.3 ms | 339.2 ms |
| Idle PSS | 452.5 MiB | 463.3 MiB |
| Peak PSS | 550.9 MiB | 557.4 MiB |

This saves 412 cold calls (30%), about 14% cold latency and cold CPU. Warm CPU
increases 3.9%, warm latency 4.6%, and idle memory 10.9 MiB. The measurements
establish a tradeoff, not its allocation-level cause or production capacity.
They do not support making this option the default for long-lived agents.

Raw control runs are `benchmark-1vm-62.json`, `65` and `67`; batch runs are
`63`, `64` and `66`, under `artifacts/results`. These runs predate the explicit
opt-in flag: `BENCH_SQL_SCHEMA_MODE=table-index` selected the control and an
unset schema mode (recorded as `0`) selected the new batch. The summarizer preserves that
historical interpretation; new reports record the effective flag explicitly.

## Reproduce

```sh
npm run core:build
npm run bench:build
CORE_CANONICAL_BATCHING=1 npm run test:core:economy
AGENTOS_V8_WARM_ISOLATES=0 BENCH_CANONICAL_BATCHING=1 BENCH_CORE_MOUNT=host_dir BENCH_WARM_TURNS=50 python3 scripts/benchmark/measure.py --allocator compact --instances 1 --trial 68
```

Choose an unused trial number to preserve existing results. Set
`BENCH_CANONICAL_BATCHING=1` for the candidate and `0` for the default control.
`BENCH_SQL_SCHEMA_MODE=table-index` also forces the control. The core probe
checks that the requested batch mode was actually exercised, and retains
four canonical schema differential cases when enabled. Retained final gate
reports are `core-probe-canonical-optin.json` and the default `core-probe.json`.

## Remaining warm runtime cost

The [shell startup investigation](wasm-shell-copy-cost.md) finds a full-binary
JavaScript number-array copy in agentOS's memory-limit rewriting. A standalone
proposed copy fix passes differential and actual memory-growth checks, but
using it in the runtime requires an upstream release or rebuild. It has not
been applied or submitted. A shell binary shrinking experiment produced no
useful speedup and was rejected; no optimizer dependency is retained.
