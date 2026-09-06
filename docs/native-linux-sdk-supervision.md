# Native SDK filesystem and supervised Linux experiment

Recorded 2026-09-06. The extracted filesystem surface is now implemented through
the native helper. An explicitly experimental SDK process path connects the
existing process/JavaScript API to a native supervisor and Linux launcher.
Production `security: 'linux-sandbox'` remains disabled. No protected performance
claim is made; actual Landlock/cgroup acceptance is blocked in this environment.

## Filesystem completion

`filesystemBackend: 'linux-openat2'` now supports all methods of the extracted
`FileApi`: read/write, batches, metadata, existence, mkdir, directory/recursive
listing, rename, and ordinary/recursive removal. Every operation uses the pinned
workspace descriptor and the native helper; none falls back to Node path access.

Parent directories are opened with openat2 beneath/no-symlink/no-mount-crossing
constraints. Mutations use mkdirat/renameat/unlinkat with those descriptors.
Mutation paths reject empty, dot and dot-dot components, trailing slashes, absolute
paths and workspace-root mutation; recursive mkdir of `.` is a no-op. Final
symlinks can be listed, moved or unlinked as objects, but are never traversed.
Recursive removal walks open directory descriptors and never follows a symlink.

Listings are bounded to 10000 entries and 1 MiB of protocol data per helper call.
SDK recursive listings also bound total entries and depth (default 32, maximum
64); recursive removal caps depth at 64 and visits at 10000 entries. Names travel
as hex-encoded bytes; the SDK rejects non-UTF-8 names instead of returning a lossy
path. UTF-8 names, including newlines and emoji, are tested. File and helper
concurrency bounds from the previous integration still apply.

These are not transactional operations. Failure/cancellation during recursive
mutation can leave partial changes. A pinned parent descriptor is stable, but
open-parent followed by mutate is not an atomic containment check against an
external process moving that directory outside the workspace. The trusted control
plane must own workspace parents and must not reassign/move active workspace
trees between owners. Standalone trusted processes remain unrestricted; this
option is not a replacement for the guest's Landlock policy or a complete tenant
ownership system. Hard-link provenance, mount administration and disk quotas
remain deployment/control-plane responsibilities.

## SDK process integration

Use the separate test entrypoint:

```js
import { createLinuxExperiment } from './packages/agentos-sdk/dist/linux-experimental-entry.js';

const vm = await createLinuxExperiment({
  acknowledgement: 'unverified-test-only',
  workspaceDir: '/absolute/private/workspace',
  cgroupDir: '/sys/fs/cgroup/existing-delegation',
  runtimeManifest: '/absolute/reviewed-runtime.json',
  memoryMaxBytes: 268435456,
  pidsMax: 64,
  cpuQuotaMicros: 20000,
  cpuPeriodMicros: 100000,
});
try {
  const result = await vm.javascript.execute('console.log("hello")', {
    output: { capture: 'all' }, timeoutMs: 8000,
  });
  console.log(result);
} finally {
  await vm.dispose();
}
```

The package export is `@agmmdotdev/agentos-sdk/linux-experimental`. Creation checks
Landlock ABI >=6, Linux x86_64, the existing cgroup2 delegation/controllers and
canonical regular-file runtime grants with SHA-256 verification. Runtime hashing
streams files rather than retaining whole executable buffers. The initial Node
must be the same canonical Node executable as the host. The factory selects the
native filesystem adapter, and does not start an idle supervisor or guest Node.
Known unsafe placement is rejected: workspaces overlapping delegation, trusted
SDK code or runtime grants, standard kernel/system trees, and kernel control
filesystems. The caller must still provision a private tree without privileged
device nodes, external hardlinks or unrelated host application code; these checks
do not replace the deployment's ownership policy.

Each process request allocates its own unique cgroup, writes bounded memory,
zero-swap, grouped-OOM, CPU and PID controls, then starts the native monitor.
Startup/disposal races recheck admission and remove an allocated but unstarted
group. The monitor enrolls a gated child before that child executes the launcher;
the launcher verifies effective limits, installs Landlock/seccomp and reports
restriction readiness before exec. The SDK waits for this readiness rather than
treating the supervisor's spawn event as successful workload startup.

Streams, stdin/EOF, logical SDK handles, output limits, timeout, cancellation,
JavaScript execution and disposal reuse the existing SDK API. `hostPid` identifies
the enrolled root, while `supervisorPid` and `cgroup` provide trusted diagnostics.
Completion waits for supervisor cleanup and removes the exact empty job cgroup.
Partial setup, missing helpers/policy, incomplete cleanup and resource failures
surface as errors. There is no automatic fallback to ordinary host execution.

The first experiment supports whole-job SIGKILL; other explicit signals fail with
`UNSUPPORTED_SIGNAL`. Custom process environments are rejected. The launcher
supplies HOME/TMPDIR/LANG and a PATH derived from reviewed command aliases.
Entry executables must be in the runtime manifest. Shell execution requires a
reviewed `sh` alias and its dynamic dependencies; shell utilities such as `cat`
also require explicit grants. Cwd opens beneath the workspace through openat2.
PTY, persistent contexts, network access, arbitrary runtime provisioning and
production tenant orchestration remain outside this experiment.

Capabilities deliberately retain `sandboxed:false` and the unverified production
guarantees. `experimentalEnforcement:'unverified-linux'` distinguishes this path.
The flags are not a claim that the candidate performs no restriction; they prevent
unvalidated implementation from being advertised as a certified SDK sandbox.

## Crash supervision

`linux-supervisor-experimental` is a small C process outside the workload cgroup,
one per active job. It owns the manager-liveness pipe and cgroup kill descriptor,
and becomes a child subreaper. Manager cancellation, pipe EOF/HUP, SIGTERM/SIGINT,
or root exit initiate `cgroup.kill`. The monitor waits for both empty cgroup
membership and all adopted children to be reaped before reporting completion.
Cleanup waits are bounded; failure is reported instead of claiming success.
The subreaper mechanism lets a living ancestor adopt and wait for orphaned
descendants. [Linux subreaper documentation](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

The monitor survives the Node manager dying. The workload root also has a parent
death signal as defense if the monitor itself dies. **That root signal cannot
guarantee cleanup of detached descendants after the monitor is SIGKILLed or
OOM-killed.** A service-level supervisor remains required for that failure domain.
No host service was installed or privileges changed here.

A dead manager also cannot remove its emptied cgroup directory. The host fixture
removes only its exact reported job. A production recovery registry/lease system
is still needed; indiscriminately sweeping empty groups would race jobs that are
allocated but not yet enrolled. Cgroup emptiness alone is not proof of reaping.
[Kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Available verification and the host gate

The suite has 38 passing tests, zero skipped. New coverage includes full directory
CRUD, recursive behavior, Unicode filenames, root guards and outside symlink
fixtures. Existing actual-openat2 race tests, SDK lifecycle/contracts, bounded
file transport and real seccomp/Node compatibility remain passing.

Supervisor tests compile the same monitor loop with **test-only process-group
control functions**. They verify exit code 7, captured output, adopted-child
reaping, explicit cancellation, EOF and an actual Node manager SIGKILL. These
tests do not establish cgroup containment or detached-child enforcement. The
distributed binary is compiled without the test macro and rejects an ordinary
directory before executing its marker payload. There is no production option to
disable its cgroup filesystem checks.

The real OpenClaw native-SDK probe passes with `AGENTOS_SDK_FILESYSTEM=linux-openat2`:
write/edit/read, shell output, exit code and timeout remain functional. Its process
path is still trusted-only in the available environment.

Two actual host suites must pass on a suitable delegated host:

```sh
npm run sdk:build
npm run test:sdk
node scripts/linux-host/runtime-manifest.mjs sh=/bin/sh cat=/usr/bin/cat > /tmp/agentos-runtime.json
# Review the exact runtime grants; ldd is only for trusted installed executables.
export AGENTOS_RUNTIME_MANIFEST=/tmp/agentos-runtime.json
export AGENTOS_TEST_CGROUP=/sys/fs/cgroup/your-existing-delegation
npm run test:linux-host
npm run test:linux-sdk-host
```

The first suite exercises the direct launcher policy/resource cases. The second
uses the actual SDK -> supervisor -> launcher -> Node path, including cwd/streams,
shell tools, EOF, timeout/cancellation and manager SIGKILL with a detached child.
Both record missing prerequisites as exit 77 / blocked, never as passing skips.
Here Landlock returns ENOSYS and no writable delegation is supplied, so zero
protected cases execute. Successful SDK/launcher cases may still reveal host
compatibility or policy defects; that code path is not declared verified.

For real OpenClaw tools on that host, after both suites pass:

```sh
npm run bench:build
AGENTOS_LINUX_EXPERIMENT=1 AGENTOS_LINUX_ACK=unverified-test-only npm run test:native-sdk
```

The experimental adapter rejects missing prerequisites and routes file/process
calls through the selected SDK path. It does not fall back to trusted execution.
The performance sampler rejects `AGENTOS_LINUX_EXPERIMENT=1`; protected timing
requires a separately reviewed measurement configuration and completed host gates.

## Remaining acceptance work

## Filesystem performance comparison (trusted processes)

Nine serial representative runs passed: three per configuration, in rotated order.
Each runs 21 turns / 105 tool calls with streamed scripted replies, real native
child programs and file assertions. Node 24.19.0, OpenClaw 2026.8.1, two CPUs,
8 MiB semi-space, identical compact allocator settings and 1.5-second idle window.
The gateway and real model inference are excluded; model waits are synthetic.

| Configuration | Median active PSS | Median idle PSS | CPU / 20 warm turns | Median warm turn |
|---|---:|---:|---:|---:|
| Direct native control | 191.41 MiB | 197.16 MiB | 6.01 s | 682.92 ms |
| Native SDK, Node file adapter | 182.92 MiB | 193.39 MiB | 4.28 s | 608.90 ms |
| Native SDK, openat2 file adapter | 185.86 MiB | 204.62 MiB | 5.05 s | 644.84 ms |

The new file adapter adds about 2.95 MiB median active PSS and 18% warm CPU over
the SDK's Node file adapter. It remains below the direct control's active memory
and warm CPU on this fixture, but has higher retained idle RAM. The native SDK
supervisor remains simpler than the direct control's original supervisor, so this
does not establish full feature parity or a universal advantage. Sampled peaks
remain variable: direct 504–680 MiB, SDK Node 523–676 MiB, SDK openat2 512–645 MiB.
100 ms sampling can miss very short-lived C helper peaks. CPU accounting includes
reaped child usage where available; raw samples and existing measurement caveats
are preserved.

These measurements exercise host SDK file calls through openat2. Child programs
still run as trusted native processes; neither Landlock/cgroup enforcement nor the
experimental native process supervisor contributes to these measurements. They
must not be presented as a protected sandbox outperforming direct Node.

Artifacts: `linux-filesystem-comparison.json`,
`linux-filesystem-benchmark-summary.json`, and raw trials 1501–1503, 1511–1513,
1521–1523 in `artifacts/results`. The sampler records filesystem selection and
native helper input hashes. The preflight capability metadata was updated after
measurement; its measurement-time hash is recorded separately.

Reproduce each mode with the same environment:

```sh
BENCH_WORKLOAD=core-workload BENCH_WARM_TURNS=20 BENCH_IDLE_MS=1500 \
AGENTOS_V8_WARM_ISOLATES=0 MALLOC_ARENA_MAX=1 MALLOC_TRIM_THRESHOLD_=32768 \
MALLOC_MMAP_THRESHOLD_=32768 MALLOC_TOP_PAD_=0 AGENTOS_SDK_FILESYSTEM=linux-openat2 \
python3 scripts/benchmark/measure.py --native --core --native-sdk --node-semi-space-mb 8 --cpus 2 --trial 1603
```

Use `AGENTOS_SDK_FILESYSTEM=node` for the SDK control and omit `--native-sdk` for
the direct control. Use distinct trial IDs and three rotated serial rounds.

## Remaining acceptance work

Run actual Landlock/cgroup and integrated OpenClaw acceptance on a supplied host;
resolve any policy/runtime-closure gaps; add deployment supervision for monitor
death and safe crash-recovery ownership; independently review the boundary; then
measure the protected configuration with manager, supervisor and all descendants
included. Gateway, tenant scheduling, complete upstream SDK/session compatibility,
virtual storage and quotas remain separate roadmap work. No multi-tenant service
or privileged host configuration was introduced by this change.
