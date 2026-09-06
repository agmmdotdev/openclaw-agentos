# Native Linux enforcement prototype

Recorded 2026-09-06. This is an **experimental host-acceptance candidate**, not an
enabled SDK sandbox. The native SDK still requires `security: 'trusted-only'`;
`security: 'linux-sandbox'` still fails before workspace access or execution.
The new helpers are not invoked by ordinary SDK file/process calls.

## Implemented and tested here

`npm run test:sdk` passes **25 tests, zero skipped**: the previous 17 SDK/contract
tests plus eight Linux primitive tests. The new evidence includes:

- Descriptor-relative read/write/stat through real `openat2`, including a pinned
  workspace directory surviving a host-side rename.
- Rejection of absolute/traversal escapes, intermediate and final symlinks,
  special-file I/O, and multiple-link files. Oversized writes are rejected before
  opening/truncating their destination; oversized reads publish no partial data.
- 100 reads and 100 writes while another thread repeatedly replaces an ancestor
  directory with an outside-pointing symlink. No outside data was read or changed.
  This exercises a real race; it is not a proof against all filesystem attacks.
- Installation of the actual syscall filter in a short-lived diagnostic process.
  Its 11 assertions cover socket denial, x32 denial, foreign process limits,
  forbidden descriptor ownership/terminal operations, and allowed stdio primitives.
  IPv4 socket creation worked before the new filter and failed after it.
- Native Node file I/O, a worker thread, and a child Node process with captured
  stdout and exit code 7 under that same filter. This test intentionally exercises
  seccomp alone and does **not** claim Landlock/cgroup protection.
- Incomplete launcher setup exits 125 before its marker-writing payload executes.

The host acceptance runner exits **77 (`blocked`)**, with zero protected cases
executed. Landlock returns `ENOSYS` (errno 38), and no writable cgroup delegation
has been supplied. The result does not identify whether the kernel or an outer
policy caused `ENOSYS`. No outer restrictions were removed or bypassed.

Evidence is in `artifacts/results/linux-enforcement-tests.txt`,
`linux-enforcement-validation.json`, and `linux-host-acceptance.json`.

## File-access primitive

`native/file-access.c` builds as `dist/linux-file-access`. Its trusted caller
passes an already-open workspace directory as descriptor 3, then the arguments
`read|write|stat`, a relative path, and a byte limit of 1–16777216. Read data is raw
stdout; write input is stdin; stat returns JSON. Errors return nonzero with stage
and numeric errno on stderr.

Resolution uses `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_XDEV`. Failed/ambiguous resolution never falls back to ordinary open.
This intentionally rejects even internal symlinks and nested mounts. The kernel
checks resolution beneath the pinned directory during the open operation.
[Linux openat2 documentation](https://man7.org/linux/man-pages/man2/openat2.2.html).

The helper handles regular-file read/write and metadata only; it is not yet a
complete SDK filesystem broker. Directories must be provisioned by the trusted
manager. Atomic replacement, recursive mutation, cancellation/backpressure glue,
and full API integration remain work. Writes are not transactional or fsynced.
Single-link checks reject existing hardlinks but cannot establish inode provenance
or prevent a trusted external process creating a new hardlink later. Workspace
provisioning and trusted control of its parent directory remain prerequisites.

Each operation uses one short-lived native helper; no idle broker is started.
This says nothing yet about full-workload memory or syscall-spawn overhead.

## Launcher candidate

`native/launcher.c` builds as `dist/linux-launcher-experimental`. It is authored
and maintained in this repository; no third-party launcher release is bundled.
The production launcher selection/review gate remains open. We inspected
[Landrun](https://github.com/Zouuup/landrun) and the
[Go Landlock library](https://github.com/landlock-lsm/go-landlock) as potential
Landlock integrations. This small C candidate lets us test the exact creation
ordering, file grants, and syscall contract before selecting the final integration.
It does not assert superiority to those projects or substitute for a security review.

The candidate is x86_64-only and requires Landlock ABI >=6, cgroup v2, empty
effective/permitted/inheritable capability sets, and manager-owned stdio/status
pipes. Host configuration is trusted. The manager must start the launcher with a
clean environment: a dynamically linked helper cannot undo loader injection that
occurred before `main()`.

Launch ordering is:

1. Validate arguments, descriptor types, capability sets and Landlock ABI.
2. Verify an empty, preconfigured cgroup's `memory.max`, `memory.swap.max=0`,
   `memory.oom.group=1`, `pids.max` and `cpu.max`; join it and verify membership.
3. Add Landlock grants for the workspace and an explicitly enumerated, read-only
   set of regular runtime files. Runtime directories are not accepted. Scope
   signals/abstract Unix sockets, deny TCP, and require all filesystem rights
   through ABI 5. Newer optional rights are not used as a substitute for seccomp.
4. Set cwd, zero core-dump limit, umask and no-new-privileges; restrict Landlock.
5. Close descriptors >=4 and arrange descriptor 3 to close on exec. Prepare a
   minimal HOME/TMPDIR/LANG/PATH environment; install the syscall allowlist.
6. Report readiness over the exec-closing status pipe; execute the absolute native
   program. Any setup failure aborts; there is no unrestricted command fallback.

Landlock restrictions are inherited by future children/threads. ABI 6 supplies
signal/abstract-socket scopes; applying the rules in a single-threaded native
launcher avoids the older-ABI multithread synchronization issue.
[Kernel Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html).

The syscall policy defaults to EPERM, rejects other audit architectures and x32,
and permits only selected native file/process/thread/runtime operations. `clone3`
returns ENOSYS to use inspectable `clone` flags; namespace flags and CLONE_PARENT
are denied. `prlimit64` is restricted to self. File ownership/permission changes,
ptrace/process_vm, descriptor extraction, mounts/namespaces, io_uring, SysV IPC,
BPF/perf/keyring interfaces, and externally addressable sockets are not allowed.

Node compatibility required a specific correction: libuv needs anonymous Unix
stream socket pairs and FIONBIO/FIONREAD for pipes. Those are permitted, along
with socket metadata queries; creating/connect/bind/listen on named/abstract or
IP sockets remains denied. Descriptor passing via sendmsg/recvmsg is not allowed.
The manager's three explicit stdio streams remain authorized communication paths.
This is external-network denial, not a promise that no socket descriptor exists.

Seccomp is one layer, not a complete sandbox.
[Kernel seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html).
Landlock does not provide a virtual root or hide all host metadata. There are no
containers, namespaces, microVMs, virtual filesystems, or a JavaScript sidecar in
this candidate.

## Reproduce on a suitable test host

Use an unprivileged x86_64 Linux account with usable Landlock ABI >=6 and an
**already delegated** cgroup with cpu/memory/pids controllers enabled. An
administrator or existing service supervisor must supply that delegation. The
runner does not modify parent controllers, install services, elevate privileges,
or provision a server. Keep it outside the workload cgroups.

```sh
npm run sdk:build
npm run test:sdk
node scripts/linux-host/runtime-manifest.mjs > /tmp/agentos-runtime.json
# Review the file-only runtime manifest before the acceptance run.
AGENTOS_RUNTIME_MANIFEST=/tmp/agentos-runtime.json \
AGENTOS_TEST_CGROUP=/sys/fs/cgroup/your-existing-delegation \
npm run test:linux-host
```

The manifest generator enumerates **the trusted installed Node** and its dynamic
dependencies with `ldd`, canonicalizes paths, and records SHA-256 hashes. Never use
it on tenant binaries. The runner verifies the hashes; unresolved runtime assets
must be investigated as explicit file grants, not fixed by granting all of `/usr`.
The current closure is a Node test closure; shell/Python/npm assets are not included.

The runner creates only unique child cgroups under the supplied delegation. Every
case uses 256 MiB memory, zero swap, 64 PIDs (32 for the PID test), and a CPU quota
of 20000/100000 microseconds. Limits include native descendants and the launcher;
they are not V8 heap settings. The memory/PID pressure loops are bounded, and each
case has output and wall-time bounds. Cleanup uses `cgroup.kill` and requires
`cgroup.events: populated=0` before accepting a result. These controls and their
delegation semantics are defined by the
[kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Nine candidate cases cover filesystem/process/environment access, network denial,
detached descendants, CPU throttling, OOM, PID limits, wall timeout, cancellation,
and output flooding. Adversarial file/signal targets are owned fixtures, not real
host secrets or arbitrary processes. Results include effective-event counters and
launcher readiness evidence. The host runner itself is not yet executed beyond
its preconditions here; its protected paths may reveal compatibility/policy bugs.

Exit codes are 77 for missing prerequisites, 1 for a failed case, and 0 for all
candidate cases passing. Even exit 0 records `sandboxEnforcementVerified:false`:
the SDK integration, independent policy review, manager-crash supervisor, orphan
reaping, broader security suite, and protected benchmark gates remain outstanding.
If this runner itself is killed, it has no independent supervisor to clean up its
cgroups. Use only a dedicated supervised test context; do not deploy this runner
as a tenant service. Empty cgroup membership proves no live attached workload,
not that all orphan zombies have been reaped by the host.

## Performance and next decision

There is **no new protected RAM/CPU benchmark**: Landlock/cgroup acceptance is
blocked, and reporting an unprotected run as protected would invalidate the
comparison. The prior PR8 trusted-only measurements remain historical: roughly
186 MiB active PSS versus 191 MiB direct native and 308 MiB agentOS hybrid. This
prototype changes neither the measured execution path nor that security label.

Next: execute the candidate suite on a supplied suitable host, resolve failures,
select and verify supervision/crash cleanup, integrate the file/process boundary
behind the SDK, then rerun real OpenClaw security parity and matched benchmarks.
Full SDK compatibility and multitenant scheduling remain separate milestones.
