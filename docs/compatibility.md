# Compatibility audit

## Verified on 2026-09-03

| Check | Result |
| --- | --- |
| TypeScript contract check | Pass |
| Provider unit tests | 10 pass |
| Package build | Pass |
| Automated builtin/export audit | Available through `pnpm audit:worker` |
| 46,593,544-byte worker transfer into agentOS VFS | Pass |
| `node:readline/promises` resolution | Adapter compatibility rewrite required |
| OpenClaw worker prewarm | Blocked by missing `node:crypto` `X509Certificate` export |

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

The preferred resolution is an AgentOS implementation of the missing exports,
starting with `hash`, `randomInt`, `flushCompileCache`, `globSync`, `writev` and
`monitorEventLoopDelay`, followed by a deliberate X.509 implementation or
capability decision. After that, rerun the probe to reveal behavioral
incompatibilities before testing full node enrollment.

The audit creates its VM with an explicit allow-list so it measures runtime
capability rather than AgentOS's narrower default builtin policy. The embedded
driver will also need an audited allow-list once these implementation gaps are
resolved.

The generated `compatibility-audit.md` report inventories all static builtin
requirements at once. This avoids fixing only the first module-linking error and
then discovering the next one during another full worker run.

## Reproduction

```bash
cd openclaw-2.0
corepack pnpm build

cd ../openclaw-agentos
corepack pnpm install --frozen-lockfile
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm audit:worker
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm probe:worker
```
