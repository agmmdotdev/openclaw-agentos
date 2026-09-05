# Compatibility audit

## Verified on 2026-09-03

| Check | Result |
| --- | --- |
| TypeScript contract check | Pass |
| Provider unit tests | 11 pass |
| Package build | Pass |
| Automated builtin/export audit | Available through `pnpm audit:worker` |
| 46,593,544-byte worker transfer into agentOS VFS | Pass |
| `node:readline/promises` resolution | Adapter compatibility rewrite required |
| Published agentOS 0.2.19 worker prewarm | Blocked by missing `node:crypto` `X509Certificate` export |
| Patched agentOS bridge bundle generation | Pass |
| Patched native Rust/V8 test | Not run: Rust toolchain unavailable in the build workspace |

The static audit covers 37 builtin modules. AgentOS resolves 36 of them, but
five modules block the unmodified worker import contract:

| Module | Gap | Recommended ownership |
| --- | --- | --- |
| `node:readline/promises` | Module alias is absent | Temporary adapter alias; add upstream |
| `node:crypto` | `X509Certificate`, `hash`, `randomInt` | AgentOS upstream; X.509 is security-sensitive |
| `node:fs` | `globSync`, `writev` | AgentOS upstream |
| `node:module` | `flushCompileCache` | AgentOS upstream; a documented no-op fallback may be acceptable |
| `node:perf_hooks` | `monitorEventLoopDelay` | AgentOS upstream or an explicit OpenClaw diagnostic capability switch |

The probe uses the unmodified OpenClaw 2026.8.1 build as its input. Before the
artifact enters the VM it rewrites only the module specifier
`node:readline/promises` to `node:readline`. agentOS's `readline` bridge already
implements promise-returning `question()` behavior when no callback is passed,
which covers OpenClaw's usage. The embedded driver applies the same rewrite to
installed JavaScript files after verifying and installing the exact bootstrap
archive.

The rewrite is intentionally visible and counted in probe output. It is a
temporary compatibility layer, not a claim that agentOS implements the missing
Node subpath.

## First full-worker blocking result

```text
SyntaxError: The requested module 'node:crypto' does not provide an export named 'X509Certificate'
```

OpenClaw imports `X509Certificate` at worker module load time. agentOS 0.2.19's
published crypto bridge exposes common hashing, signing, encryption and random
APIs but not `X509Certificate`. A fake class would let module linking continue
while silently weakening certificate behavior, so this adapter does not add
one.

The included agentOS patch implements `hash`, `randomInt`,
`monitorEventLoopDelay`, and the missing module/export registrations. Existing
agentOS implementations of `globSync` and `writev` are exposed to ESM, and
`flushCompileCache` is a documented no-op because the VM has no Node on-disk
compile cache. It exports an `X509Certificate` constructor only as an explicit
`ERR_NOT_IMPLEMENTED` boundary. This lets unrelated worker paths link without
pretending certificate parsing is safe or complete.

The audit creates its VM with an explicit allow-list so it measures runtime
capability rather than agentOS's narrower default builtin policy. The embedded
driver now uses the same audited set after its temporary readline rewrite.

The generated `compatibility-audit.md` report inventories all static builtin
requirements at once. This avoids fixing only the first module-linking error and
then discovering the next one during another full worker run.

The report still describes the published 0.2.19 runtime. Static bridge bundle
generation succeeded for the patch, but that is not equivalent to a native
runtime pass. Build the Rust sidecar and run the consolidated V8 test before
changing the report to zero blockers. See [agentos-patch.md](agentos-patch.md).

## Reproduction

```bash
cd openclaw-2.0
corepack pnpm build

cd ../openclaw-agentos
corepack pnpm install --frozen-lockfile
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm audit:worker
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm probe:worker
```
