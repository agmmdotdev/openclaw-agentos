# Bounded SQLite statement reuse

The host adapter previously prepared every guest statement invocation again.
An opt-in per-connection LRU now reuses eligible prepared statements. In the
retained full-core workload it reduces adapter statement prepares from 1,935
to 1,588 (17.9%), but does **not establish a meaningful end-to-end CPU, memory,
or warm-turn improvement**. The default remains `statementCacheSize: 0`.

## Measurements

Each run executes one cold and 50 warm OpenClaw read-plus-shell turns with the
same deterministic inference, tools, transcript checks, 256 MiB guest heap,
read-only core artifact mount, compact allocator and zero spare V8 isolates.
Compilation is outside measurement. OpenClaw remains 2026.8.1 and agentOS
remains the published 0.2.19; no upstream package or runtime binary is changed.

| Metric | Cache disabled, runs 105/106 | 32 entries, runs 104/107 |
| --- | ---: | ---: |
| Statement prepares, including teardown | 1,935 / 1,935 | 1,588 / 1,588 |
| Reused statements, including teardown | 0 / 0 | 347 / 347 |
| Binding calls through 51 turns | 2,473 / 2,473 | 2,473 / 2,473 |
| Warm-turn median | 320.5 / 344.5 ms | 324 / 340.5 ms |
| CPU across 50 warm turns | 24.05 / 25.10 CPU-s | 23.53 / 25.92 CPU-s |
| Host SQL time across warm turns | 60.7 / 64.0 ms | 62.0 / 60.2 ms |
| Idle process-tree PSS | 468.0 / 458.8 MiB | 461.2 / 448.0 MiB |
| Peak process-tree PSS | 561.4 / 549.4 MiB | 552.4 / 547.8 MiB |
| Launch to first result | 3.49 / 3.17 s | 3.07 / 4.14 s |

These are two process runs per configuration, not 100 independent process
samples. Run 107 resumed in a later session, so this is not an uninterrupted
ABBA comparison. Memory and CPU differences are insufficient to support a
default change. CPU uses the existing nearest-sample method with reaped-child
accounting. `prepares` counts the adapter's statement operations, not prepares
inside upstream schema collectors or the connection's version query.

Runs 101–103 are retained as exploratory evidence. Run 102 overlapped
typechecking/tests and is excluded; 103 predates the final eligibility rules.
The focused [comparison JSON](../artifacts/results/statement-cache-comparison.json)
references all retained comparison files. Regenerate it with
`python3 scripts/benchmark/statement-cache.py`.

## Behavior and bounds

`createHostSqlite(root, { statementCacheSize: 32 })` and
`createCoreHostSqlite(root, { statementCacheSize: 32 })` enable the experiment.
The size must be an integer from 0 to 128 and applies separately to each
database handle. Closing a handle or disposing the service drops its cache.

Only SELECT/INSERT/UPDATE/DELETE/REPLACE/WITH statements and the exact read-only
`PRAGMA data_version` and `PRAGMA user_version` forms are eligible. Other
statements, `exec()`, and `columns()` clear the connection cache. This preserves
fresh preparation for operations that can have prepare-time effects and fresh
column metadata. Failed executions are evicted. SQLite executes each reused
statement again and handles schema reprepare; query results are never cached.

SQL is limited to 16,384 JavaScript string units and encoded request payloads
to 32,768 units for caching. Large requests still execute but are not retained:
native statements can retain their most recent bound values. The limit bounds
retained entries and inputs, not an exact native-memory byte budget.

Every call restores integer-reading and named-parameter settings so guest
statement objects with identical SQL cannot leak options into each other.
The existing SQLite authorizer, tenant path mapping and transport limits remain
in force. No guest protocol or OpenClaw artifact rewrite is needed.

## Validation and reproduction

The host tests pass with caching both disabled and enabled. They check option
reset, omitted parameters, typed data, rollback, schema changes from a second
connection, live PRAGMA versions, failed inserts, LRU eviction, large-request
bypass, closed handles and isolation. The existing 11 provider tests,
typecheck, and four profile/schema tests also pass.

`CORE_SQL_STATEMENT_CACHE=32 npm run test:core:economy` passes the full core gate,
including tools, failure recovery and restored workspace/transcript behavior.
Its separate output is
`artifacts/results/core-probe-statement-cache-32.json`, preserving the default
probe report.

For a new benchmark, choose an unused trial number:

```sh
BENCH_SQL_STATEMENT_CACHE=32 BENCH_CORE_MOUNT=host_dir BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 108
```

Use `BENCH_SQL_STATEMENT_CACHE=0` for the control. Do not run tests or other
benchmarks concurrently with either measurement.

The engineering conclusion is to prioritize fewer guest/host crossings and
published shell-runtime improvements. Optimizing roughly 60 ms of host SQL
work across 50 turns cannot close the observed multi-second warm CPU gap.
