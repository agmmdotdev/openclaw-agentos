# agentOS compatibility patch

The repository includes
[`patches/0001-feat-execution-cover-OpenClaw-builtin-imports.patch`](../patches/0001-feat-execution-cover-OpenClaw-builtin-imports.patch).
It applies to agentOS commit
`65dc5e67642dab8beb90363044effd8aa6b97755` and produces local patch commit
`3c37fbc58555abdaa80ffbdab83d33d516a3ca83`.

## Scope

| Surface | Change | Behavioral status |
| --- | --- | --- |
| `node:readline/promises` | Registers the subpath and reuses the guest-owned readline implementation | Implemented |
| `crypto.hash` | Uses the existing kernel-backed hash implementation | Implemented |
| `crypto.randomInt` | Uses rejection sampling over six secure random bytes | Implemented |
| `crypto.X509Certificate` | Exports a constructor that throws `ERR_NOT_IMPLEMENTED` | Deliberately unsupported |
| `fs.globSync` | Adds the existing implementation to ESM named exports | Implemented upstream already |
| `fs.writev`, `fs.writevSync` | Adds existing implementations to ESM named exports | Implemented upstream already |
| `module.flushCompileCache` | No-op because the guest has no Node on-disk compile cache | Implemented as lifecycle compatibility |
| `perf_hooks.monitorEventLoopDelay` | Adds a bounded guest-timer histogram | Implemented |

The X.509 boundary matters: OpenClaw imports the constructor through code that
is bundled into its worker even when a worker turn does not use certificate
parsing. The explicit throwing constructor permits module linking but does not
support TLS certificate fingerprinting. Do not use the patch for a pinned-TLS
Gateway until agentOS has a real certificate parser with conformance tests.

## Apply and validate

```bash
git clone --depth 1 https://github.com/rivet-dev/agent-os.git agentos
cd agentos
git fetch --depth 1 origin 65dc5e67642dab8beb90363044effd8aa6b97755
git checkout 65dc5e67642dab8beb90363044effd8aa6b97755
git am ../openclaw-agentos/patches/0001-feat-execution-cover-OpenClaw-builtin-imports.patch
pnpm install --frozen-lockfile
pnpm --dir packages/build-tools run build:v8-bridge --out-dir /tmp/agentos-v8-bridge
cargo test -p agentos-execution --test javascript_v8 javascript_v8_suite -- --nocapture
```

Then build the local agentOS package and sidecar, and point the integration
audit at it without editing `package.json`:

```bash
AGENTOS_CORE_MODULE=file:///absolute/path/to/agentos/packages/core/dist/index.js \
AGENTOS_CORE_PACKAGE_JSON=/absolute/path/to/agentos/packages/core/package.json \
OPENCLAW_REPO=../openclaw-2.0 \
pnpm audit:worker:strict
```

Only after the native test and strict audit pass should the full worker prewarm
be used to discover the next behavioral incompatibility.
