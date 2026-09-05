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
- cleanup and provider contract tests;
- a compatibility probe for the built OpenClaw worker artifact.

The embedded driver is deliberately a development implementation. Its VM map
lives in the Gateway process, so a Gateway restart cannot adopt those in-memory
VMs. Production durability will use an agentOS/Rivet actor driver while keeping
the same `AgentOsDriver` interface.

The provider is not production-runnable yet. The real 46.6 MB OpenClaw worker
is transferred into agentOS and begins module loading. The complete static
audit currently finds five blocking builtin modules; the first full-worker
failure is agentOS 0.2.19's missing `node:crypto` `X509Certificate` export.
These are agentOS runtime-compatibility blockers, not OpenClaw
provider-contract failures. See [docs/compatibility.md](docs/compatibility.md).

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

Until the crypto gap is resolved, this probe is expected to exit non-zero and
report the missing `X509Certificate` export.

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
