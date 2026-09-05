# Core runtime experiment — compatibility fixes

The newer [runtime benchmark](runtime-benchmark.md) documents the reduced core
profile, login-shell fix, allocator settings, schema batching and current Node comparison. Timing
observations later in this investigation describe the earlier full artifact.

## Decision and scope

The two previously failing cases now pass within a compiled compatibility
boundary. A JavaScript child-process adapter fixes completion cleanup. An
AsyncLocalStorage adapter plus async-syntax lowering fixes the exercised context
propagation paths. Keep the published-runtime, out-of-tree approach as a
**bounded prototype**. Raw agentOS still has the original context defects; this
work does not make arbitrary Node code context-safe.

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

The builder fails closed on a different worker digest. It parses the
bundle with TypeScript, slices the core profile, rewrites ten retained import specifiers, and adds
`runOpenClawCoreTurn(params)`. That wrapper calls the upstream generated
`init_embedded_agent_runtime()` before `runWorkerEmbeddedTurn(params)`.
Failing to invoke that initializer leaves module-local constants unset; simply
exporting the function is not sufficient.

The builder then lowers async functions, async generators and for-await loops
with esbuild 0.28.2. It preserves function names and modern non-async syntax.
Two retained native async-iterator prototype expressions (three in the full profile) are replaced with an
imported intrinsic that remains native. The reduced profile removes the worker CLI entry. The full control retains
module-level waiting, with its operation moved into a lowered function. These matches are
count-checked against the pinned input.

The build manifest records input/output hashes, compiler version/settings,
intrinsic-reference count and individual adapter hashes.
This remains an artifact patch and a private, pinned implementation boundary.

## What executes where

| Component | Location |
| --- | --- |
| OpenClaw agent loop, session setup, tool selection and execution | agentOS guest |
| OpenClaw `read`, `write`, `edit`, `apply_patch` | agentOS guest filesystem |
| Shell / Node child commands | agentOS process subsystem |
| Transcript projection and commit/terminal ordering | OpenClaw guest code |
| Inference responses | Deterministic fixture injected into the real core interface |
| SQLite SQL execution and original table-contract collection | Scoped host Node SQLite, invoked through guest binding CLI |
| Schema comparison, migration decisions and integrity checks | Original OpenClaw guest code |
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
| Missing AsyncLocalStorage static bind/snapshot | Capture known adapter instances for callback binding |
| Incorrect async store lifetime and native-await propagation | Restore stores synchronously; lower async syntax to captured promise continuations |
| Login-shell environment probe hangs for 15 seconds | Match the exact default-shell probe and use working `printenv -0`, retaining NUL records and shell startup |
| Child-process cleanup throws on missing `removeAllListeners` | Add event-scoped/all listener removal to the pinned child-process prototype |
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
The harness checks actual final file contents, foreground exec status/exit code,
and that transcript settlement precedes the finishing event. The earlier suite
checked `isError` and file contents, which missed failed process completion in
`details.status`; that assertion gap is now closed.

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
- Three background commands are polled through completion and preserve exit
  codes 0, 7 and 127 plus stdout. OpenClaw labels ordinary exit 7 completed and
  shell-failure exit 127 failed; the harness checks that upstream behavior.

The host SQLite test checks commit/rollback, actual transaction state, blobs,
64-bit integers, reopening data and separate tenant namespaces. ATTACH and
VACUUM INTO cannot create a file outside the database namespace. Closed or
foreign handles are rejected.

## Async-context fix and its boundary

The raw runtime's `AsyncLocalStorage.run()` keeps a mutable store until the
returned promise settles. Native `await` bypasses its patched `.then()` capture.
`async_hooks.createHook()` is a no-op, `v8.promiseHooks` has no working hooks,
and `globalThis.AsyncContext` is absent in the inspected runtime.

The adapter calls native `run()` with a synchronous wrapper that captures the
callback's result without returning it to native `run()`. This restores the
caller immediately and returns the original result/promise unchanged. The
compiler converts async operations into generator steps driven by `.then()`,
which agentOS already captures. Neither part alone is sufficient.

`npm run probe:async-context` compares native host Node, compiled host Node,
raw agentOS, the adapter without compilation, and the compiled adapter path.
The last path matches Node across 13 deterministic scenario records: overlap
in both completion orders, immediate/post-await restoration, nested stores,
rejection/finally, timers, microtasks, promise callbacks returning promises,
async generators, bind/snapshot/AsyncResource, promise identity, thrown callback
cleanup, externally resolved promises and `exit()` restoration. Raw and
uncompiled controls remain visibly incorrect in the saved report.

This is a **static compiled-code boundary**, not a general runtime repair:

- Injected context-sensitive callbacks must also be compiled. The harness does
  this for inference, transcript and live-event fixtures.
- Dynamically loaded plugins, eval/Function-generated code and arbitrary native
  async callbacks are not certified. Uncompiled native await loses context.
- Lowering can affect reflection and scheduling. Three stream ponyfills inspected
  the native async-generator prototype; those exact expressions now use an
  uncompiled intrinsic module. Broader reflection compatibility is unproven.
- Reduced compiler output is 16,598,661 bytes versus 46,593,544 input bytes
  (the previous full compiled artifact was 53,604,203 bytes). This does not
  establish guest memory overhead or a production cost advantage.
- The tests establish exercised context behavior, not secure concurrent customer
  isolation or support for simultaneous OpenClaw turns in one VM.

## Process-completion fix

Temporary instrumentation of `buildExecRuntimeErrorOutcome` revealed
`TypeError: child.removeAllListeners is not a function` during the supervisor's
ownership cleanup. The command had exited normally; cleanup converted its
outcome to a runtime failure with no exit code. This also affected foreground
commands, even when their filesystem side effects succeeded.

The new adapter supplies `ChildProcess.prototype.removeAllListeners`, clearing
persistent and one-shot registrations. It handles a selected event or all
events, including symbols, and returns the child. It checks agentOS 0.2.19's
listener-table representation before operating. These internal tables are a
pinned dependency, not a portable EventEmitter API; this does not certify all
Node event-emitter semantics. It preserves child process execution and actual
exit codes. No completion is fabricated, and diagnostic instrumentation is not
part of the shipped artifact.

Capability checks verify scoped removal, one-shot removal, retained listeners,
symbol events and real child close/exit codes 0 and 7. Integrated tests verify
foreground completion and background exit codes 0, 7 and 127 through OpenClaw.

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

**Update:** [the measured benchmark](runtime-benchmark.md) now provides native
Node controls, process-tree memory and concurrent-instance evidence. The
current runtime is materially slower and larger at idle than Node for this
workload. Shared-sidecar binding routing also failed; the harness now uses a
unique sidecar pool and closes it explicitly after VM disposal. Separate-pool
routing passes its standalone gate. The original sequential results below
remain valid but do not establish multi-tenant placement.


Observed runs before final packaging were approximately:

- First five-tool turn: 17–18 seconds after loading; about 20–22 seconds for the
  process including initialization (the final combined initial run including
  eight additional scenarios took about 23 seconds).
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
async-context probe also exits nonzero on adapted-path or compiled-Node
divergence; failing raw-runtime controls are diagnostic evidence. The latest
core gate passes all three generations, 132 capability assertions (100 are
random-integer bounds), and eight failure/background scenarios. Unit tests and TypeScript
checks remain separate from the real-runtime compatibility gate.

The source archive includes the integration repository, generated small result
files, build scripts, fixtures and git history. Large regenerated bundles,
installed dependencies, temporary databases and the reference checkout are
excluded. No GitHub upload or external issue submission has been performed.
