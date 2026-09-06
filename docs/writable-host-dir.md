# Writable host-directory experiment

The published native `host_dir` backend can reduce filesystem cost, but it is
**not adopted for tenant workspace or state**. A disposable probe shows that
`limits.resources.maxFilesystemBytes` does not reject an oversized write on
this backend in agentOS 0.2.19. The default remains `chunked_local`.

This is a diagnostic experiment, not a replacement storage implementation or
a claim of equivalent durability, permissions, or hostile-tenant isolation.
The existing read-only code mount remains separate and unchanged.

## Measured performance

All four runs use the published agentOS 0.2.19, OpenClaw 2026.8.1, read-only
core code mount, 256 MiB guest heap, compact allocator, zero spare V8 isolates,
and disabled SQL statement cache. Each performs one cold and 50 warm turns.
The host SQLite service stays unchanged; only workspace/state mounts differ.

| Workload / metric | chunked_local | host_dir |
| --- | ---: | ---: |
| Read plus shell: warm median | 341.5 ms | 317 ms |
| Read plus shell: 50 warm turns CPU | 25.73 CPU-s | 24.78 CPU-s |
| Read plus shell: idle process-tree PSS | 457.2 MiB | 457.4 MiB |
| Read plus shell: peak process-tree PSS | 557.8 MiB | 550.1 MiB |
| Read only, exec still available: warm median | 39 ms | 29 ms |
| Read only, exec still available: 50 warm turns CPU | 2.40 CPU-s | 1.90 CPU-s |
| Read only, exec still available: idle process-tree PSS | 388.2 MiB | 384.6 MiB |
| Read only, exec still available: peak process-tree PSS | 389.2 MiB | 386.6 MiB |

The read-only pair observes 26% lower median latency and 21% lower warm CPU.
The shell pair observes only 7% lower latency and 4% lower warm CPU. These are
**one process run per configuration per workload**, not independent repeated
measurements. They identify a candidate cost; they do not establish a robust
speedup or memory improvement. No default optimization is claimed.

Runs 108/109 are host_dir/chunked_local with shell; 110/111 are
chunked_local/host_dir with read only. All normal benchmark completion and
transcript checks pass. Compilation and tests did not overlap measurement.
CPU uses the existing sampled process-tree method, including reaped children.
The [focused comparison](../artifacts/results/writable-host-dir-comparison.json)
retains the metrics and links them to raw benchmark filenames.

## Behavior probe and adoption blocker

The [probe result](../artifacts/results/writable-host-dir-probe.json) uses
self-created temporary fixture directories and guest uid 1000. Both backends
pass read/write/rename, an internal symlink, fsync, and file restoration after
VM disposal/recreation. No host-only marker is read or changed in the tested
escape attempts.

The escape setups differ: chunked_local rejects creation of the two external
symlinks with EXDEV. For host_dir, the host pre-creates absolute and relative
external symlinks inside the mount; guest reads return EACCES and attempted
writes leave the external marker unchanged. This is limited fixture evidence,
not a symlink-race, hard-link, adversarial multi-tenant, or crash-consistency
proof. The persistence check restores a file, not a full core transcript.

With a 1 MiB filesystem limit:

| Attempt | chunked_local | host_dir |
| --- | --- | --- |
| Write a 2 MiB file | Rejected with ENOSPC and maximum-filesystem-size message | Succeeds |

This observed difference alone blocks adoption as an equivalent default. The
host directories also use writable mode bits beneath a private temporary
parent, whereas chunked_local uses guest uid 1000 ownership and 0700 roots.
The sandbox cannot chown a host directory to host uid 1000 (EINVAL), so host
permission equivalence is not demonstrated either. No user directory is used.

## Reproduce

```sh
node scripts/run-core-economy.mjs scripts/diagnostics/probe-writable-host-dir.mjs
python3 scripts/benchmark/summarize.py --trials 108 109 110 111 --output writable-host-dir-comparison.json
```

The probe exits nonzero on a required filesystem/persistence failure. Quota
behavior is reported separately, so exit zero does not mean the backend is
approved as a replacement. The benchmark-only `BENCH_DATA_MOUNT=host_dir`
switch exposes the experiment; the normal core launcher has no such switch.

For a fresh run, choose an unused trial number:

```sh
BENCH_DATA_MOUNT=host_dir BENCH_WORKLOAD=core-read-ready BENCH_CORE_MOUNT=host_dir BENCH_WARM_TURNS=50 AGENTOS_V8_WARM_ISOLATES=0 python3 scripts/benchmark/measure.py --allocator compact --trial 112
```

Omit `BENCH_DATA_MOUNT` for the chunked_local control, and use
`BENCH_WORKLOAD=core-shell` for the shell workload. Run comparisons sequentially.

The next optimization target remains reducing VFS crossings while preserving
the existing storage contract, or using a published backend that supplies
equivalent quota and permission behavior. Shell startup still dominates the
shell-heavy case; changing the workspace backend does not remove that cost.
