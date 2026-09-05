# Batch upstream schema inspection across the host boundary

This report records the first table-collector pass. The subsequent
[startup pass](runtime-startup-pass.md) also batches the original named-index
collector, reducing cold binding calls from 1,700 to 1,373. Historical figures
and the original collector size below describe the table-only implementation.

This pass reduces cold-start SQL transport by running OpenClaw's existing
read-only table-contract collector alongside the host SQLite connection.
The guest still performs schema comparison, migration decisions and integrity
checks. There is no schema-result cache and no replacement validation algorithm.

## Implementation

The builder extracts the pinned `collectSqliteTableContract` function and its
SQL parsing helpers from the same verified worker used by the core build.
The generated host module is 12,477 bytes, including retained legal notices.
It has no imports and opens no connections. The build rejects dependency
expansion beyond the reviewed module boundary. The host verifies its recorded
SHA-256 before loading it.

The generated guest artifact adds a narrowly matched hook at the start of the
original collector. Adapter databases expose `collectOpenClawTableContract()`;
native Node databases keep using the original function body. The individual
query implementation remains available as a differential control.

`createCoreHostSqlite()` configures the existing scoped SQL service with the
verified collector. The new operation validates the database handle and table
name, runs the original collector against that connection, and returns its
result through the existing typed transport. A Map wire type preserves column
definitions and their iteration order. The native SQLite authorizer, handle
isolation, extension prohibition and payload/result bounds remain in place.
The collector reads current connection state on every call, including the
caller's uncommitted DDL. It does not add a cross-call transaction or promise
an atomic snapshot across independent writers.

The guest module grows by 98 bytes to 16,598,661 bytes. Its unlowered Node
counterpart is 14,597,452 bytes. This is an additional pinned artifact hook,
not an upstream source fork or runtime-binary patch. Host schema inspection is
now part of the adapter boundary; saying that every piece of OpenClaw code runs
inside the guest would be inaccurate.

## Correctness evidence

The host differential test compares the transported result with the same
upstream collector on direct Node SQLite. It covers:

- Strict and WITHOUT ROWID tables, expression and partial unique indexes,
  triggers, FTS virtual tables and quoted identifiers.
- A real Map of column definitions, missing tables, and a hostile table-name
  string passed as data.
- ALTER TABLE / DROP INDEX inside a transaction, followed by rollback, with
  no stale metadata from prior calls.
- Rejection of another tenant's handle, a closed handle and an invalid name.

The real guest test compares batched and individual collectors for canonical
schema, deliberate column/index drift and rollback. It checks both the complete
contract (including Map entries and Unicode column ordering) and the resulting
schema issues. Canonical schemas pass; drift still fails the same checks.

The integrated core passes real tools, failed/background processes, read-only
restrictions, transcript failure paths and VM restoration. Capability coverage
rises from 129 to 132 assertions. The tests retain the existing unsupported
compaction/extension boundaries. Two independent guest instances are measured
with dedicated sidecars and separate SQL services.

## Measurement controls

`BENCH_SQL_SCHEMA_MODE=individual` disables only the new guest method during
benchmark staging. The collector hook falls through to the original function;
all other code, allocator settings and workload stay the same. The driver
checks the method replacement count so a changed control cannot silently leave
batching enabled. This mode and all profiling flags are recorded in each run.

The first paired comparison, trials 19 and 20, measured:

| Measurement | Individual queries | Batched collector |
| --- | ---: | ---: |
| Cold SQL binding calls | 3,306 | 1,700 |
| Guest time in SQL transport | 2.22 s | 1.25 s |
| Cold turn after worker-ready | 3.74 s | 2.77 s |
| Launch to first completed turn | 4.46 s | 3.50 s |

The host SQL work stays near 0.2 seconds: the gain comes largely from reducing
transport trips, not doing less validation. The remaining calls include table
existence checks, index inspection, rowid inspection and state/migration work.
They were not cached or skipped to improve the benchmark.

Trial 24 is retained as a 6.14-second cold-start outlier. It still made exactly
1,700 cold binding calls and passed. Guest SQL elapsed time rose to 1.73 seconds;
the entire cold turn took 5.48 seconds. The probes do not explain all the extra
time, so we do not label the variation as an identified runtime defect or
attribute it solely to shared-machine contention. Subsequent paired repeats
are included in the current benchmark table.

## Warm-turn boundary

Trial 21 instruments child process events. The first `/bin/sh` invocation
reported exit at 285 ms after the spawn call began. The five warm invocations
reported 189–233 ms; their spawn events arrived at 12–14 ms. This elapsed
interval includes command execution and runtime event delivery. It is not an
isolated CPU profile.

Warm complete turns remain around 0.3 seconds, versus about 27 ms directly on
Node. Batching cold schema inspection does not address most of that gap.
Replacing a simple shell command with a direct file read would overfit this
benchmark and lose shell behavior, so it was not adopted. Further warm-latency
work needs to address the published shell/process path while preserving command
semantics, cancellation, output and process ownership.

## Reproduce

Build artifacts before the profile-specific test:

```sh
npm run core:build
npm run test:core-profile
npm run test:core:compact
npm run core:report
npm run bench:build
npm run bench:core -- --instances 1 --allocator compact --trial 30
BENCH_SQL_SCHEMA_MODE=individual npm run bench:core -- --instances 1 --allocator compact --trial 31
BENCH_PROFILE_PROCESS=1 BENCH_PROFILE_CORE=1 npm run bench:core -- --instances 1 --allocator compact --trial 32
BENCH_PROFILE_SQL=1 npm run bench:core -- --instances 1 --allocator compact --trial 33
npm run bench:report
```

Keep diagnostic runs out of aggregate performance comparisons. Raw reports
retain them, and the latest performance summary preserves the cold outlier.
