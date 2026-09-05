# Architecture

## Lifecycle

1. OpenClaw persists placement intent.
2. `resolveAllocation()` derives a stable agentOS lease ID from the OpenClaw
   operation ID without allocating anything.
3. `provision()` creates or adopts an agentOS VM.
4. OpenClaw creates a replay-safe node enrollment and an exact bootstrap
   descriptor.
5. The driver downloads the bootstrap in the trusted host, verifies its byte
   length and SHA-256 digest, and streams it into the VM filesystem in bounded
   chunks so it never depends on one oversized RPC frame.
6. agentOS installs the verified package in its VM and starts the OpenClaw node
   as a VM process.
7. The node connects outbound to the Gateway. The provider returns the device
   ID supplied by OpenClaw's enrollment callback.
8. OpenClaw dispatches one `worker-turn` assignment through that node.
9. `destroy()` terminates the VM process tree and disposes the VM.

## Trust boundary

- The Gateway and this provider plugin are trusted host code.
- OpenClaw's bootstrap bearer token is used only by the trusted provider and is
  never passed to the long-lived node process.
- The setup code is stored only in the agentOS VFS and passed by filename.
- The worker gets no model-provider credential. Inference remains proxied by
  the Gateway.
- agentOS gates guest filesystem, process, environment and network operations.

## Known gaps before production

1. The embedded driver is process-local. A durable agentOS/Rivet actor driver
   is required for Gateway restart adoption.
2. TLS-certificate-pinned private bootstrap URLs are rejected. The actor driver
   must implement pin verification before sending bearer credentials.
3. agentOS 0.2.19's crypto bridge lacks the `X509Certificate` export that the
   OpenClaw worker imports. The real worker transfer passes, but module loading
   stops at this explicit compatibility blocker. See `compatibility.md`.
4. OpenClaw nodes are long-lived processes. agentOS actor sleep must remain
   disabled or held while a node is connected; sleeping destroys running
   processes even though the VFS persists.
5. Browser/computer tools and native binaries are outside this phase. They need
   AgentOS sandbox mounting or another full sandbox backend.

Gateway topology, public ingress and Cloudflare deployment are intentionally
outside this repository's current phase. This first cut establishes and tests
the execution-provider boundary before those decisions are coupled to it.
