import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchOpenClawSource } from "../dist/src/compatibility.js";
import { writeLargeFile } from "../dist/src/write-large-file.js";

const agentOsModuleSpecifier =
  process.env.AGENTOS_CORE_MODULE ?? "@rivet-dev/agentos-core";
const { AgentOs } = await import(agentOsModuleSpecifier);

const repository = resolve(process.env.OPENCLAW_REPO ?? "../openclaw-2.0");
const workerPath = resolve(repository, "dist/worker/worker.mjs");
const originalWorker = await readFile(workerPath, "utf8");
const patched = patchOpenClawSource(originalWorker);
const worker = Buffer.from(patched.source);

console.log(
  `Loading ${worker.byteLength} byte OpenClaw worker into agentOS (${patched.replacements} compatibility replacement(s))`,
);
const startedAt = performance.now();
const vm = await AgentOs.create({
  permissions: {
    fs: "allow",
    childProcess: "allow",
    process: "allow",
    env: "allow",
    network: "deny",
  },
  limits: {
    resources: {
      maxProcesses: 32,
      maxOpenFds: 256,
      maxSockets: 64,
      maxFilesystemBytes: 512 * 1024 * 1024,
    },
    process: {
      pendingStdinBytes: 64 * 1024 * 1024,
      pendingEventCount: 10_000,
      pendingEventBytes: 64 * 1024 * 1024,
    },
    jsRuntime: {
      v8HeapLimitMb: 256,
      cpuTimeLimitMs: 120_000,
      wallClockLimitMs: 180_000,
      importCacheMaterializeTimeoutMs: 120_000,
      syncRpcWaitTimeoutMs: 120_000,
    },
  },
});

try {
  const guestPath = "/home/agentos/openclaw-worker.mjs";
  await writeLargeFile(vm, guestPath, worker);
  const result = await vm.process.execFile("node", [guestPath, "--internal-worker-prewarm"], {
    timeoutMs: 180_000,
    output: { capture: "all" },
  });
  console.log(JSON.stringify({
    result,
    durationMs: Math.round(performance.now() - startedAt),
  }, null, 2));
  if (result.outcome !== "succeeded" || result.exitCode !== 0) process.exitCode = 1;
} finally {
  await vm.dispose();
}
