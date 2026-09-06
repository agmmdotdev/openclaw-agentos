# Extracted agentOS SDK: native Node backend

An executable **partial SDK extraction**, based on agentOS 0.2.19 at commit
`9ae6abbdc48391a75b8336e7832b3e76f42616ee`. It preserves the selected public API
and execution result types. Execution types and API declarations are extracted;
native filesystem/process implementations are new. The entire original SDK
class, Rust runtime, software catalog, and session engine are not copied here.
See `UPSTREAM.json`, `NOTICE`, and `LICENSE` for provenance and attribution.

**Native mode is currently trusted-only. It is not a Linux security sandbox.**
`security: 'linux-sandbox'` always rejects with `SANDBOX_UNAVAILABLE`, including a
capability report, before opening a workspace or launching workload code. No
verified Linux enforcement launcher is integrated. An experimental C launcher,
openat2 file helper and host acceptance runner now exist; see
[the enforcement report](../../docs/native-linux-enforcement-prototype.md).
They are separate from ordinary SDK execution. This cannot be fixed merely
by selecting a flag or installing the SDK on another host.

## Build and use from this repository

```sh
npm run sdk:build
npm run test:sdk
```

Use the standalone native entrypoint for no agentOS runtime dependency:

```js
import { AgentOs } from './packages/agentos-sdk/dist/native-entry.js';

const vm = await AgentOs.create({
  backend: 'native-node',
  workspaceDir: '/absolute/path/to/existing/workspace',
  security: 'trusted-only',
});
try {
  await vm.filesystem.writeFile('hello.mjs', 'console.log("hello")');
  const result = await vm.javascript.executeFile('hello.mjs', {
    output: { capture: 'all' },
    timeoutMs: 1000,
  });
  console.log(result.outcome, result.stdout);
} finally {
  await vm.dispose();
}
```

The package exports this entrypoint as `@agmmdotdev/agentos-sdk/native` when
installed/linked. It is private and has not been published to npm. It uses Node
builtins only at runtime. `dist/linux-preflight` is a small compiled C capability
probe, not a sandbox launcher; rebuild it for the host architecture. Native trusted
execution does not run the probe or start a sidecar.

The combined entrypoint permits explicit, lazy selection of the original SDK:

```js
import { AgentOs } from './packages/agentos-sdk/dist/index.js';
const vm = await AgentOs.create({
  backend: 'agentos',
  options: { /* unchanged published agentOS options */ },
});
try {
  // Full published agentOS behavior remains available on this selection.
} finally {
  await vm.dispose();
  // Dispose a caller-owned explicit sidecar separately when appropriate.
}
```

That selection requires the optional peer `@rivet-dev/agentos-core@0.2.19` and
returns the original instance; it does not reimplement its internals. The combined
entrypoint's type declarations reference that peer. The standalone native
entrypoint's declarations do not. Build/contract checking in this repo uses the
installed peer and verifies the extracted API types in both directions.

## Implemented native surface

| Area | Methods |
|---|---|
| Filesystem | readFile, writeFile, readFiles, writeFiles, stat, mkdir, readdir, readdirEntries, readdirRecursive, exists, move, remove |
| Process | spawn, get, list, tree, wait, signal, kill, writeStdin, closeStdin, readOutput, exec, execFile |
| JavaScript | execute, executeFile, spawn, spawnFile |
| Lifecycle | explicit create, idempotent dispose, capability report |

Shared contract tests exercise both native and original backends. Tests cover
Unicode data, real shell output/exit, metadata, native/guest child Node execution,
default capture behavior, move/remove, and persistence. This is representative
parity on the selected surface, not exhaustive upstream compatibility.

Important semantics:

- `workspaceDir` is a real canonical host path. Relative SDK paths resolve there.
  There is no virtual `/workspace` mount. Programs receive a native cwd; their
  absolute paths are not rewritten. File operations preserve actual Linux errors.
- File APIs reject direct outside paths and outside-pointing symlinks, and use
  `O_NOFOLLOW` on file opens. These checks are **not** race-proof against hostile
  concurrent renames and do not restrict an arbitrary child program's host access.
- Child environments contain PATH/HOME/LANG plus explicit caller additions, rather
  than inheriting all manager credentials. This hygiene is not sandbox isolation.
- `process.exec()` uses `sh -c`; `execFile()` and `spawn()` pass argv without a shell.
  Attached execution closes stdin, captures no output by default, and supports
  explicit `output.capture: 'all' | 'stderr' | 'none'`. `retainEvents: true` is
  supported only for spawned processes. Callbacks receive UTF-8 byte chunks.
- SDK PIDs are monotonically allocated handles within one VM handle, not host PIDs.
  Native descriptors also expose `hostPid` for diagnostics. Completed entries are
  retained in a bounded history; evicted handles return `PROCESS_NOT_FOUND`.
- `process.list/tree` describe managed root processes; tree children are empty.
  They are not an enumeration of arbitrary native descendants.
- Timeout, AbortSignal, kill, shell-exit cleanup, and dispose signal the managed
  process group. **A descendant can escape it with `setsid()`; this backend does
  not contain hostile detached descendants.** Cleanup waits are bounded and can
  report `CLEANUP_TIMEOUT`. Manager crashes are not supervised by this package.
- Disposal preserves workspace files. Persistent interpreter contexts are not
  implemented; JavaScript calls use fresh native Node processes.
- Oversized output kills the command and returns an error; slow callbacks can
  block the trusted manager event loop. This is not an async output-consumer API.

## Bounds, not kernel resource guarantees

| Option | Default | Scope |
|---|---:|---|
| managedProcessLimit | 32 | Managed root admission, not total descendant PID count |
| outputLimitBytes | 1 MiB | Per-command stdout+stderr and pending stdin bound |
| retainedProcessLimit | 32 | Completed descriptors/replay retained per handle |
| maxFileBytes | 16 MiB | SDK buffered file/read-batch limit, not disk quota |

Batch operations accept at most 1024 entries. Recursive listings cap at 10000
entries and depth 32 by default (configurable 0–64). These local bounds do not
limit child RAM, CPU, filesystem writes, networks, or forked descendants. The
caller is trusted; hostile caller allocations/callbacks are outside this model.
Unknown create and execution options are rejected rather than silently treating
unsupported permissions or resource limits as enforced.

## Unsupported native APIs

Linux sandbox enforcement, hard process-tree limits, filesystem quotas,
race-resistant host file brokering, bindings, sessions/ACP, persistent contexts,
PTY/terminal, Python and TypeScript convenience APIs, npm installation helpers,
network services, software catalog projection, cron, virtual/custom mounts,
snapshots, and arbitrary SDK compatibility are not implemented. Accessing the
exposed unsupported namespace/method paths throws `UNSUPPORTED_CAPABILITY`.
Some options rejected here are valid on the original backend.

Native Node may itself run JavaScript packages or native programs; that does not
implement the omitted agentOS orchestration APIs. The native result must not be
used for untrusted tenant code until a real enforcement backend and its tests
exist. No performance measurement in this milestone establishes sandbox safety.

## Extraction maintenance

`src/language-execution.ts` was copied from the pinned source with its `JsonValue`
import replaced by a local recursive type. `src/sdk-surface.ts` extracts the
selected namespace methods and supporting filesystem interfaces. Regenerate the
surface from the exact source checkout and installed npm release with:

```sh
node packages/agentos-sdk/scripts/extract-surface.cjs /path/to/agentos-checkout
npm run sdk:build
```

The extractor verifies the checkout commit. `upstream-contract-check.ts` ensures
selected type signatures match the installed 0.2.19 package. Upgrading the SDK
requires refreshing provenance and re-running runtime contract tests, not only
accepting a TypeScript build.
