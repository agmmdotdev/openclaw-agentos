# SDK process supervision

Follow-up to PR #20, merged at `43b5a116a4d5b8cc151f5fff5a6d0a8cd4072659`.

SDK processes now run beneath OpenClaw's existing process supervisor. Previously
the SDK bridge replaced only `spawn`, while cancellation, scope joins and record
lookup still used the host supervisor's unrelated registry. The bridge also
omitted requested output capture, run metadata and automatic no-output deadlines.
A real pre-change process printed `captured`, but its completed result had no
`stdout` field.

## One lifecycle owner

`upstream/src/process/supervisor/supervisor-runtime.ts` contains the extracted
supervisor implementation. It accepts a low-level process adapter factory.
`supervisor.ts` retains the existing host child/PTY/anchored-shell selection and
logging. The SDK package integration uses the same lifecycle implementation with
`src/sdk-process-adapter.mjs`; it does not duplicate the registry or timer logic.

The shared implementation owns run records, bounded output capture, deadlines,
graceful cancellation and forced termination, scope replacement fences, shutdown
admission, and scope joins. Duplicate active run IDs are rejected before a second
process starts. Decoded/raw output callbacks are guarded so callback errors reject
the run instead of escaping through stream events or leaving completion pending.
Output detachment now clears raw callbacks as well as decoded callbacks.

`withProcessSupervisor` binds all five supervisor operations to the turn owner:
spawn, cancel, cancelScope, getRecord and waitForScope. Retained operations reject
after the binding closes. A later binding can continue a background command using
the same underlying supervisor. An injected turn no longer initializes the host
supervisor just to borrow its non-spawn methods.

## SDK adapter responsibilities

The SDK adapter translates OpenClaw's prepared shell route into SDK process calls.
It buffers early output until subscriptions attach, decodes UTF-8 using the shared
output helper, and drains output before resolving completion. The SDK's output
limit still bounds received bytes; OpenClaw separately bounds retained text.

Stdin writes go directly to the SDK, preserving its pending-input byte checks.
An intermediate writable queue would delay those checks and retain extra input.
The adapter exposes callback completion and writable/end/closed state. Initial
input failures retain their actual error code; interactive EPIPE is returned to
the caller without killing a command that intentionally closed its input.

SDK process handles remain private arguments to SDK methods. The exposed process
PID comes from the SDK's observed host PID. SDK output-limit and adapter failures
reject `wait()` and finalize the supervisor record as a failure.

## Package usage and lifecycle

Build with `npm run source-core:build`. The `./tool-runtime` package subpath now
points to a small compiled entry built from owned source and the shared supervisor.
It contains no schema/model graph and does not create an SDK handle on import.
The `./request-state` subpath remains the unchanged native ESM checkpoint module.

`createAgentOsToolRuntime(vm, { env })` returns `{ sandbox, supervisor }`. Pass that
object as `toolRuntime` to `runOpenClawCoreTurn`. The previous spawn-only injection
is removed from the experimental source API and all current callers are updated.

The caller owns the SDK handle and supervisor lifetime. On teardown, await
`supervisor.shutdown()` before disposing the handle; use a `finally` block to
dispose the handle even when shutdown reports an error. Keeping the same runtime
allows background work across turn bindings. Disposing it at each request boundary
ends those commands; a transcript checkpoint does not resume an OS process.

The benchmark adapter retains only setup, counters and teardown. Source fixtures
select the matching standard/minified tool-runtime build. Historical artifact
fixtures retain their old global injection for reference comparisons.

## Validation

Commands used for the final validation:

```sh
npm run source-core:build
npm run test:source-runtime
npm run test:source-core
node scripts/benchmark/build.mjs
python3 scripts/benchmark/probe-hybrid.py --native-sdk --request-profile
npm run source-core:build:minified
CORE_MINIFY=1 npm run test:source-runtime
npm run test:source-core:minified
git diff --check
```

Runtime tests use real SDK child processes for bounded/stream-only/raw output,
stdin/EOF, no-output deadline resets, scope cancellation and joins, duplicate
identities, cancelled replacements, delayed startup during shutdown, callback
detachment, SIGTERM-to-SIGKILL escalation, output-limit errors and stdin errors.
The startup race tests delay admission with a deterministic barrier and then call
the real SDK; they do not substitute fake process results.

The real OpenClaw exec/process test creates a background command, closes its
creator binding, and continues it through another binding. It verifies list,
Unicode write/send-keys/EOF, poll/log/clear, cancellation, deadline reporting, and
rejection of operations from a different scope. Results are acknowledged through
the same internal result-acknowledgment hook used by the agent loop.

The core suite additionally checks all 28 config/locale cases, schema deferral,
highlighter behavior, three separate checkpointed requests per build, all-method
binding isolation/revocation, and a real command through the default host adapter.

Final results: **17 runtime/checkpoint tests and seven core tests pass in each
build layout**. Each core suite makes 15 checkpointed-turn tool calls and 18
exec/process calls; the existing native request-profile probe adds five, for
**71 real tool calls** in the final checks. Expected cross-scope rejections are
included in that call count. Package subpaths resolve and whitespace checks pass.
The standalone supervisor entry is 39,951 bytes standard / 18,717 bytes minified,
with 11 build inputs and no config/model source inputs.

## Remaining limits

The adapter supports prepared SDK shell commands with open/closed pipes. PTY,
host-inherited stdin, secret descriptors, Windows-specific spawn behavior and
exact-environment promises remain unsupported and are rejected before execution.
Broader filesystem bridge options and operations remain separate compatibility
work. Scope keys must identify the intended session within the process; the
existing process-tool registry is not a new tenant isolation boundary.

The SDK's trusted process-group cleanup is unchanged. No broader descendant
extinction, Landlock/cgroup enforcement, host-death containment or production
sandbox guarantee is claimed. Live-provider tests and whole-upstream typechecking
have not run. Manual review uses the existing user waiver of fresh automated review.

This is a compatibility change. The default core selection stays unchanged and
there is no new CPU/RAM/latency claim. Before a default switch, close remaining
required filesystem/tool compatibility gaps and run fresh matched measurements,
including external runtime-dependency freezing noted in the
[ownership audit](source-optimization-migration.md).
