# Core runtime experiment — 2026-09-05

## Decision and scope

Continue the published-runtime, out-of-tree approach as a **bounded prototype**.
The core flow is executable, but runtime fidelity has reached a concrete wall:
agentOS's AsyncLocalStorage does not isolate overlapping async contexts and
retains a store after a completed async scope. A successful sequential demo is
not sufficient evidence for a secure, concurrent runtime.

No upstream repository or published package was modified. No containers or
Rust builds were used. No Gateway server, channel integration or deployment
was implemented. The older provider driver is unchanged.

## Exact input

- OpenClaw npm package: `2026.8.1`.
- Reference source tag: `v2026.8.1`.
- Worker: `dist/worker/worker.mjs`, 46,593,544 bytes.
- SHA-256: `03eca1d346aa24fd5028b2ca8d09385b764bf9dd2c82810ce564043a34356f1c`.
- agentOS npm package: `@rivet-dev/agentos-core@0.2.19`.
- Host used for these tests: Node 24.19.0, SQLite 3.53.3, Linux x64.
- Latest agentOS version returned by the registry during this work: 0.2.19.

The builder fails closed on a different worker digest. It parses only the
bundle's import preamble with TypeScript, rewrites module specifiers, and adds
`runOpenClawCoreTurn(params)`. That wrapper calls the upstream generated
`init_embedded_agent_runtime()` before `runWorkerEmbeddedTurn(params)`.
Failing to invoke that initializer leaves module-local constants unset; simply
exporting the function is not sufficient.

The build manifest records input/output hashes and individual adapter hashes.
This remains an artifact patch and a private, pinned implementation boundary.

## What executes where

| Component | Location |
| --- | --- |
| OpenClaw agent loop, session setup, tool selection and execution | agentOS guest |
| OpenClaw `read`, `write`, `edit`, `apply_patch` | agentOS guest filesystem |
| Shell / Node child commands | agentOS process subsystem |
| Transcript projection and commit/terminal ordering | OpenClaw guest code |
| Inference responses | Deterministic fixture injected into the real core interface |
| SQLite SQL execution | Scoped host Node SQLite, invoked through guest binding CLI |
| Workspace and transcript durability | Published agentOS native `chunked_local` mounts |

The fixture has no model API credentials and the guest network policy is deny.
It tests tool-call consumption, result feedback, streaming-shaped message
events, transcript content and lifecycle behavior. It does not test real LLM
reasoning or an external provider's HTTP/SSE transport.

## Blockers resolved without a source fork

| Blocker | Adapter or configuration |
| --- | --- |
| Missing named crypto exports | Real `hash` via native hashing; bounded rejection sampling for `randomInt` |
| Unused certificate import | Explicit throwing X509 constructor; certificate operations stay unsupported |
| `globSync` / `writev` named exports | Delegate to existing default fs implementation |
| Missing optional stat behavior | Preserve `throwIfNoEntry:false` for ENOENT; ordinary errors still throw |
| Missing compile-cache flush | No-op optimization; guest has no Node disk compile cache |
| Event-loop histogram import | Explicit unsupported error; no fabricated telemetry |
| Missing promise-readline module | Wrapper; interactive usage has not been exercised |
| Missing process memory-constraint method | Returns Node's documented unknown value, 0; not a RAM estimate |
| Missing Latin-1 TextDecoder | Windows-1252 decoding for supported WHATWG labels, UTF-8 delegated to native |
| Missing AsyncLocalStorage static bind/snapshot | Capture known adapter instances for callback binding; does **not** fix async propagation |
| Unlisted dynamic builtins | Explicit allow-list additions, discovered during execution |
| SQLite 3.46.0 rejected for WAL safety | Host SQLite adapter, preserving OpenClaw's version check |
| Worker exceeds dependency import response cap | Launch one combined entry artifact using bounded chunked transfer |
| Missing parser WASM assets | Copy exact installed web-tree-sitter and Bash grammar assets |
| Linux OOM-score wrapper probes nonexistent guest `/proc` file | Upstream `OPENCLAW_CHILD_OOM_SCORE_ADJ=0` opt-out |

Static imports alone missed dynamic dependencies including querystring,
console, constants and inspector. Exposing a name does not establish its full
behavioral compatibility.

## Verified behavior

The primary turn performs write → read → edit → shell exec → apply_patch →
final assistant response. Each tool result returns to the next inference call.
The harness checks actual final file contents and that transcript settlement
precedes the finishing event.

A second turn in the same guest process consumes the earlier transcript and
reads both an edited file and shell output. The host then disposes the VM,
closes SQLite connections, recreates the VM with the same durable mounts,
restages the immutable code, and runs another turn. That turn receives 18 prior
transcript messages and successfully accesses the prior files. This is
application-state recovery, not a running-process snapshot or crash test.

Negative cases verify:

- An already-aborted turn does not call inference and reports cancellation.
- Inference exceptions propagate with an error terminal event.
- Failed transcript commits prevent a success terminal event.
- Read-only mode excludes write/edit/apply_patch, and a model attempting the
  absent write tool cannot create the target file.
- A missing-file tool result returns to the model interface and the loop can
  produce a final response.

The host SQLite test checks commit/rollback, actual transaction state, blobs,
64-bit integers, reopening data and separate tenant namespaces. ATTACH and
VACUUM INTO cannot create a file outside the database namespace. Closed or
foreign handles are rejected.

## Remaining failures

### Async context: independently reproduced in unmodified agentOS

Run `npm run probe:async-context`. It runs identical code on real Node and
published agentOS with no OpenClaw artifact and no compatibility modules.

| Scenario | Node | agentOS |
| --- | --- | --- |
| One async scope finishes | Store cleared afterward | Store remains afterward |
| Two scopes, first finishes first | context-0, context-1 | context-1, context-1 |
| Two scopes, second finishes first | context-0, context-1 | context-1, context-1 |

This can affect ambient execution identity, tracing and other context-dependent
behavior. Keeping one customer per VM is necessary isolation work, but does not
repair overlapping internal operations or scope cleanup within that VM.
The narrow static bind adapter does not claim to solve this.

The reliable fixes are upstream runtime async-context support or an explicit
context design in the application paths that currently depend on it. The latter
could justify an OpenClaw fork, but it is more substantial than an import patch.
No such fork was started in this task.

### Background process completion

The full OpenClaw `exec(background:true)` → `process.poll` scenario starts a
child, returns a session ID, and captures `background-ok`. It then reports a
failed process with an unknown exit code. The assertion remains failing.

Separate direct agentOS child-process probes delivered exit and close codes 0
and 7 correctly. Disabling the unsupported OOM-score wrapper removes `/proc`
noise but does not repair the OpenClaw background case. The exact cause in the
integrated process-management path has not been established; it must not be
papered over by assuming exit code 0.

## Persistence findings

Setting `database:{type:'sqlite_file',path:...}` alone did not recover the
default root VFS after recreation. Explicit `chunked_local` mounts at
`/workspace` and `/state` did.

The mount root was created as guest uid 0 despite uid/gid options in its
configuration. The harness provisions ownership with a short-lived guest-root
setup VM, disposes it, and runs all core turns as the default guest uid 1000.
No host OS privileges are granted to the guest. Immutable code is restaged in
the ephemeral root; user workspace and transcript state use the durable mounts.

## SQLite adapter limits

This is a scoped SQL capability, **not a transparent Node SQLite replacement**:

- File-backed databases are mapped to opaque hashed files on the host. Their
  bytes and WAL files do not appear through guest fs. Raw database backups,
  rename/unlink, file identity checks and all recovery flows are not established.
- The tested core path and restart pass; this does not certify every OpenClaw
  state migration, read-only reopen, corruption repair or concurrent writer.
- Statements are prepared on each RPC; prepare-time error timing and iterator
  streaming differ from Node. Extension loading and callbacks are unsupported.
- Host database calls are synchronous and are not governed by guest V8 CPU or
  heap limits. A production service needs resource isolation and query budgets.
- Each environment owns its binding closure, handles and storage namespace.
  There is no process-global database-handle pool across customers.

These limits are recorded rather than hidden behind passing core assertions.

## Performance interpretation

Observed runs before final packaging were approximately:

- First five-tool turn: 17–18 seconds after loading; about 20–22 seconds for the
  process including initialization.
- Warm two-tool continuation in the same process: 0.35–0.55 seconds.
- Restored two-tool continuation in a new process: roughly 20 seconds including
  initialization.

These are local synthetic-inference observations, not a comparative benchmark,
cost estimate, or promise of production latency. Different turns do different
work. More than 3,000 SQL binding calls occur during cold state initialization;
each currently incurs synchronous binding-CLI overhead. Reusing the initialized
process amortizes this work. No density, per-tenant RAM or hosting-cost claim is
made from bundle size or the 256 MiB configured heap cap.

## Reproduction and gates

Use the README commands. `npm run test:core` runs capability assertions, core
turns, negative cases and restoration, preserving every result in one report.
It exits nonzero if any capability or integrated scenario fails. The independent
async-context probe also exits nonzero on divergence. Unit tests and TypeScript
checks remain separate from the real-runtime compatibility gate.

The source archive includes the integration repository, generated small result
files, build scripts, fixtures and git history. Large regenerated bundles,
installed dependencies, temporary databases and the reference checkout are
excluded. No GitHub upload or external issue submission has been performed.
