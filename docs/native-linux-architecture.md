# agentOS SDK with a native Linux backend

Status: proposed implementation design, 2026-09-06. No backend selector or
capability API described here exists in the published SDK today.

## Preserve the API, replace execution behind an interface

Fork the SDK layer and extract a backend contract. Keep existing agentOS behavior
behind its own implementation. The native implementation manages workspaces and
runs ordinary executables under a Linux sandbox launcher. Prefer an existing,
maintained launcher after reviewing its behavior and deployment requirements;
a small native helper may be needed. A pure-JavaScript security implementation
is not assumed, and rewriting the Rust sidecar protocol is not the starting point.

Use a separate native entrypoint or equivalent lazy module boundary so selecting
native does not load the original engine, agent bundles, or unrelated adapters.
Do not replace the public API with an unrelated facade and call it full SDK
compatibility: define the supported slice and retain contract tests against both
backends. Unsupported methods/options fail explicitly before code executes.

## Trust and ownership

| Component | Authority and lifetime |
|---|---|
| Trusted Node host | SDK manager, OpenClaw core, configuration, credentials, transcript/storage orchestration |
| Workspace handle | Validated identity, assigned disk directories, policy, process registry; can exist without a running guest process |
| Sandbox launcher | Establishes the required restrictions before tenant-controlled instructions run |
| Native child process tree | Untrusted tools/scripts; separate V8 heaps when running Node; no host object access |
| Files on disk | Persist independently of process lifetime; explicit deletion is separate from disposal |

Never evaluate tenant code, package scripts, or untrusted plugins in the manager
process. Sharing trusted core code does not authorize sharing mutable tenant
state. Request-based core activation and a scheduler are later milestones, not
an always-on core requirement introduced by this design.

Only broker-approved handles reach children. Environment variables, inherited
file descriptors, working directories, and IPC endpoints are part of the
boundary. Host bindings, when added, validate ownership and inputs for every
call; they do not expose arbitrary host filesystem or process access.

## First supported slice

| API area | Initial contract |
|---|---|
| Create/dispose | Prepare policy and workspace; no permanent process per idle handle; idempotent tree cleanup without deleting persistent files |
| Filesystem | Read/write/stat/mkdir with defined encoding, error, and symlink behavior |
| Process | Spawn executable plus argv, wait, kill/cancel, stdin write/close, output streams, exit reason |
| Limits | Enforce supported process-tree RAM/CPU/PID limits; distinguish a wall timeout from a CPU budget |
| Capability report | Required/enforced/unavailable features and explicit unsupported APIs; version the report |

Do not map a guest V8 heap limit to a whole-process memory limit without exposing
the semantic difference. Initial filesystem storage has no hard byte quota unless
a real quota mechanism is implemented and tested; byte counting before writes
is not sufficient when native children can write concurrently.

Host SDK file operations need the same ownership policy as guest operations.
A string prefix or `realpath` followed by an ordinary open is insufficient against
symlink/rename races. Evaluate descriptor-relative access with suitable kernel
resolution constraints or a restricted filesystem broker. Do not grant arbitrary
mount paths through user-controlled SDK options.

## Filesystem and path decision gate

Start with real, private per-workspace directories and an explicitly approved,
read-only runtime/tool closure. Include required libraries and runtime assets;
do not expose the entire host installation or all of `/usr` by convenience.

Landlock restricts access; it does not provide a virtual filesystem or rewrite
absolute paths. Native children cannot automatically see their directory as
`/workspace`. The first native contract should expose its actual `workspaceDir`
and launch relative paths with that cwd. SDK-level path aliases must be documented
separately from paths visible to child programs. Never rewrite arbitrary shell
source to simulate a mount.

If exact guest `/workspace` semantics become a requirement, evaluate a real root
view in a separate decision. Mount/user namespaces are container-related kernel
primitives even without Docker; do not introduce them silently under the existing
no-container constraint. No namespace-based design is selected here.

agentOS `chunked_local`, custom JS mounts, snapshots, and remote storage plugins
are not directly readable by native programs. Preserve ordinary filesystem
persistence first. FUSE, materialization, remote synchronization, and quota-backed
storage are distinct future work with explicit consistency/cost tradeoffs.

## Linux enforcement contract

The target is restricted native execution on Linux, not a guest OS or protection
against kernel vulnerabilities. Broader metadata visibility and side channels
must not be represented as VM-equivalent isolation.

- Apply filesystem policy and syscall restrictions before untrusted execution.
  Set no-new-privileges; eliminate privilege transitions and unintended inherited
  descriptors. Enforcement must reach all subsequently created children/threads.
- Start with guest networking denied. Cover TCP, UDP, IPv6, local/abstract Unix
  sockets, and inherited connected descriptors. Landlock network features vary
  by ABI; it is not by itself a hostname allowlist. A future network broker is a
  separate feature.
- Address cross-process signals, ptrace, `/proc` access, and escape-capable kernel
  interfaces. A policy must permit Node's required threads and runtime operations
  while blocking unauthorized interactions with the host and other workloads.
- Place the child under the intended delegated cgroup before tenant execution;
  keep the trusted manager outside its workload's limits. Set and verify memory,
  CPU and PID controls; prohibit child migration or limit changes.
- Kill and reap the entire job, including detached descendants. Process-group
  killing alone does not establish this guarantee. Specify timeout, cancellation,
  output-limit, OOM, normal exit, and manager-failure behavior separately.

A production capability check fails closed if any required restriction cannot be
established. An unrestricted diagnostic backend, if retained, must have a distinct
name and cannot satisfy the sandbox test or benchmark gate. Exact minimum ABIs,
syscall policy, and launcher choice remain outcomes of the host/launcher milestone.

## Deferred compatibility

Host-binding IPC, JavaScript evaluate/execute wrappers, PTY and output replay,
background sessions, Python/TypeScript conveniences, npm installation, ACP agents,
cron, network services, software catalog projection, root snapshots, and dynamic
mounts need separate contracts. No stubs may return success for unsupported work.
Native Node compatibility does not automatically implement these SDK semantics.

Keep the full-core-inside-sandbox design separate from the first native-core /
sandboxed-tools target. Gateway, tenant scheduling, authentication, and a production
storage control plane are deferred; test fixtures may use two workspace identities
solely to exercise access separation.
