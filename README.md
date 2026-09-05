# OpenClaw agentOS Worker Provider

An out-of-tree OpenClaw 2.0 `WorkerProvider` that provisions isolated
[Rivet agentOS](https://github.com/rivet-dev/agentos) VMs. OpenClaw itself is
not forked.

## Status

This repository implements the first integration boundary:

- a valid `agentos` OpenClaw worker-provider plugin;
- deterministic, idempotent lease identities;
- `worker-turn`-only placement and node enrollment;
- an embedded agentOS lifecycle driver;
- exact bootstrap download, byte-count and SHA-256 verification;
- bounded streaming transfer for bootstrap and worker artifacts larger than a
  single agentOS RPC frame;
- bootstrap installation inside the VM and OpenClaw node startup;
- an isolated compatibility rewrite for agentOS's missing
  `node:readline/promises` alias;
- an explicit 36-builtin runtime allow-list derived from the pinned worker;
- cleanup and provider contract tests;
- a compatibility probe for the built OpenClaw worker artifact; and
- a reviewable agentOS source patch for the five remaining import blockers.

The embedded driver is deliberately a development implementation. Its VM map
lives in the Gateway process, so a Gateway restart cannot adopt those in-memory
VMs. Production durability will use an agentOS/Rivet actor driver while keeping
the same `AgentOsDriver` interface.

The provider is not production-runnable yet. The published agentOS 0.2.19
runtime still has five blocking builtin modules; the first full-worker failure
is its missing `node:crypto` `X509Certificate` export. This repository now
contains an agentOS patch that closes the static import surface, but the native
patched runtime has not yet been built and exercised end to end. In particular,
`X509Certificate` deliberately throws `ERR_NOT_IMPLEMENTED`, so certificate
parsing and pinned-TLS flows remain unsupported rather than being faked. See
[docs/compatibility.md](docs/compatibility.md) and
[docs/agentos-patch.md](docs/agentos-patch.md).

## Compatibility baseline

| Component | Pinned version |
| --- | --- |
| OpenClaw | `2026.8.1` (OpenClaw 2.0) |
| agentOS | `0.2.19` |
| Node.js | `>=22.22.3` |

## Development

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm build
```

To test the actual OpenClaw worker bundle inside agentOS, first build OpenClaw
2.0 and then run:

```bash
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm audit:worker
OPENCLAW_REPO=../openclaw-2.0 corepack pnpm probe:worker
```

The audit checks every statically imported Node builtin and named/default
export. `audit:worker:strict` exits non-zero when it finds blockers, making it
suitable as an upgrade gate in CI.

Against published agentOS 0.2.19, this probe is expected to exit non-zero and
report the missing `X509Certificate` export. The audit and probe also accept
`AGENTOS_CORE_MODULE` plus `AGENTOS_CORE_PACKAGE_JSON` so a locally built
agentOS patch can be selected without changing this repository's dependency.

## OpenClaw profile

The provider accepts these worker-profile settings:

```json
{
  "network": "allow",
  "maxFilesystemBytes": 1073741824,
  "v8HeapLimitMb": 256,
  "installTimeoutMs": 600000
}
```

Network access is required for a real worker to connect outbound to its
Gateway. The one-GiB filesystem limit is intentional: OpenClaw's verified
bootstrap archive is at most 25 MiB, but its installed dependency tree is much
larger.

## Boundary

The Gateway remains authoritative for placement state, transcripts, provider
credentials, bootstrap generation and tool authority. agentOS owns only the
isolated execution VM, its virtual filesystem, process tree and outbound
network policy.

See [docs/architecture.md](docs/architecture.md) for the lifecycle and known
gaps.
