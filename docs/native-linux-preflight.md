# Native Linux backend preflight

Recorded 2026-09-06. Status: design approved; backend implementation has not
started. This report concerns the inspected development environment, not the
user's deployment server.

## Decision and scope

Preserve the agentOS SDK experience through a focused TypeScript/JavaScript SDK
fork with an explicit native Linux backend. Native Node and Linux tools execute
under kernel-enforced restrictions. The trusted SDK manager can live in the
existing host process; a permanent runtime process per workspace is not required.

The user has now approved the SDK-fork direction, superseding the earlier
no-agentOS-fork constraint for this work. No Rust runtime fork is selected.
The no-container/no-microVM constraint and the decision to defer gateway/channel
and multitenant implementation remain in effect. This milestone records plans;
it does not create a separate fork repository or claim a working sandbox.

Next: [architecture](native-linux-architecture.md) and
[implementation roadmap](native-linux-roadmap.md).

## Inspected software

| Input | Version / revision |
|---|---|
| OpenClaw | 2026.8.1 |
| agentOS core SDK and sidecar | 0.2.19 |
| Host Node | 24.19.0 |
| Wasmer SDK / Edge.js comparison | 0.11.0 / 0.2.0 |
| Local baseline commit | `301b5b452a0feca45a69d9aff82d06bd1857dc24` |
| Equivalent published baseline | `d1ee4db0b12abdb04af560c336f0c646a9458b0c` (PR #6) |

SDK inspection used the installed, pinned npm release, not an upstream default
branch. Its package metadata identifies `rivet-dev/agentos`, `packages/core`, and
Apache-2.0 licensing. Verify the matching source revision and preserve applicable
license/notice files when establishing the SDK fork; that source mapping is not
yet verified.

### SDK findings

- `dist/agent-os.js`: `AgentOs.create()` parses options, resolves a sidecar,
  creates a JavaScript VM, configures mounts/software, registers bindings, and
  constructs `NativeSidecarKernelProxy`.
- `dist/agent-os.d.ts`: instances keep private sidecar client/session/VM fields;
  filesystem, process, language, session, and other APIs extend beyond our slice.
- Sidecar configuration selects shared or explicit sidecars, not an arbitrary
  backend implementation. There is no public native-Linux backend seam today.
- `dist/sidecar/rpc-client.d.ts`: the proxy combines VFS, process events, signals,
  sockets, software projection, and mount reconfiguration. Reimplementing its
  entire wire protocol would commit us to much more than OpenClaw currently uses.
- The SDK declares the sidecar/runtime packages, agent software, SQLite, AWS SDK,
  and other dependencies. Native-only import/startup cost must be measured;
  introducing an interface without splitting eager imports will not guarantee
  lower memory.

Inspection fingerprints (SHA-256 of installed files):

| File under `node_modules/@rivet-dev/agentos-core/` | SHA-256 |
|---|---|
| `package.json` | `eea78c61c2abd86e62b050914b798fa5004ad8f716a9ccce14f3fb8679dda036` |
| `dist/agent-os.js` | `59d5969521d7872313804518dfaeeaae14de3a5829314ee602055ea67f657c9a` |
| `dist/agent-os.d.ts` | `a9f9494a34a7f545529cc8f16fe635928fd24e5e601ed2300f812cb778dc39c8` |
| `dist/sidecar/rpc-client.d.ts` | `788ffd07c83318e8f15b93925bf35e838e82fba5d5e681d0f445b34c0605fe67` |

### Existing integration seam

`scripts/benchmark/hybrid-adapter.mjs` already connects real OpenClaw tools via a
sandbox filesystem bridge and process supervisor. Its exercised SDK surface is:
filesystem read/write/stat/mkdir; spawn/wait/kill; stdin write/close; streamed
stdout/stderr; and disposal. The native core, its loaded plugins/configuration,
SQLite, and transcripts remain trusted host operations.

That benchmark adapter is the first integration target. It is not proof that
all providers under `src/`, every OpenClaw tool, or the complete agentOS API can
switch backends unchanged. Its string-based path check is not a production
filesystem boundary. It also adds an explicit timeout timer because the existing
SDK timeout alone failed the probe.

## Linux capability observations

Read-only queries were made from a normal tool process. No attempt was made to
change namespace policy, install a new seccomp filter, or acquire privileges.

| Observation | Result | Interpretation |
|---|---|---|
| Kernel / architecture | Linux 6.18.35 / x86_64 | Kernel version alone does not establish usable features |
| UID / GID | 0 / 0 | Numeric root does not imply available privileges here |
| Effective / bounding capabilities | Both zero | No capabilities available to this process |
| `NoNewPrivs` | 1 | Already restricted |
| Seccomp mode / installed filters | 2 / 1 | Existing syscall filtering is active |
| Landlock ABI query | `ENOSYS` (38) | Unavailable through this execution environment; cause unresolved |
| `/sys/kernel/security/lsm` | Not exposed | Cannot inspect enabled LSMs through this path |
| Cgroup v2 controllers | cpuset, cpu, io, memory, hugetlb, pids | Controllers are visible |
| Cgroup subtree control | Empty | No child controllers enabled at this visible location |
| Cgroup root writable access | False | Writable controller delegation is not established |
| Namespace-count sysctl | 2147483647 | Does not prove namespace creation is permitted |
| Available binaries | node, cc, bwrap, setpriv, prlimit, systemd-run | Presence is not execution/permission validation |
| Missing binaries | nsjail, landrun | Neither is selected or installed by this preflight |

The Landlock query was `landlock_create_ruleset(NULL, 0,
LANDLOCK_CREATE_RULESET_VERSION)` through syscall 445 on x86_64. `ENOSYS` does
not distinguish kernel configuration from an outer syscall filter masking the
call. Cgroup evidence came from `/proc/self/cgroup`, `mountinfo`, the controller
files, and `os.access`; no delegated subtree was created or exercised.

**Result:** SDK contract/refactor work can proceed here. Full sandbox enforcement
and resource-limit acceptance are blocked in this environment until a suitable
host is available. Do not substitute ordinary child processes and label them
sandboxed. Installation of a launcher alone cannot fix missing kernel access.

## Performance baseline and limits

Two clean 21-turn trials per backend, matching host settings and two Linux CPUs:

| Native core's tool backend | Active PSS MiB | Retained idle PSS MiB | CPU for 20 warm turns (s) |
|---|---:|---:|---:|
| Native, unrestricted control | 191.0 | 205.2 | 6.00 |
| agentOS | 304.4 | 304.8 | 21.50 |
| Wasmer SDK | 1828.4 | 2791.3 | 34.83 |

These are measurements, not predictions for the proposed backend. The native
control includes child tool processes but has no security boundary. Two trials,
scripted inference, and a short idle window cannot establish production capacity.
See [the full comparison](wasmer-sdk-comparison.md) and its raw reports.

## External references

- [Landlock userspace API](https://docs.kernel.org/userspace-api/landlock.html):
  restrictions are ABI-dependent; query support rather than infer it from version.
- [Seccomp filter API](https://docs.kernel.org/userspace-api/seccomp_filter.html):
  syscall filtering is one component, not a complete sandbox.
- [Cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html):
  delegation and controller configuration are necessary for resource enforcement.
