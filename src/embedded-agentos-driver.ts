import { AgentOs, type ProcessDescriptor } from "@rivet-dev/agentos-core";
import type { WorkerLeaseStatus } from "openclaw/plugin-sdk/plugin-entry";
import { downloadBootstrap } from "./bootstrap-download.js";
import {
  applyOpenClawCompatibility,
  OPENCLAW_AGENTOS_NODE_BUILTINS,
} from "./compatibility.js";
import type { AgentOsProfile } from "./config.js";
import type { AgentOsDriver } from "./types.js";
import { writeLargeFile } from "./write-large-file.js";

type LeaseState = {
  vm: AgentOs;
  profile: AgentOsProfile;
  nodePid?: number;
  bootstrapSha?: string;
};

const text = new TextDecoder();

function stateRoot(leaseId: string): string {
  return `/home/agentos/.openclaw-workers/${leaseId}`;
}

async function ensureSucceeded(
  result: { outcome: string; stderr?: string; stdout?: string; exitCode?: number },
  action: string,
): Promise<void> {
  if (result.outcome === "succeeded" && (result.exitCode === undefined || result.exitCode === 0)) {
    return;
  }
  const detail = result.stderr?.trim() || result.stdout?.trim() || result.outcome;
  throw new Error(`${action} failed: ${detail}`);
}

export function createEmbeddedAgentOsDriver(options: {
  warn?: (message: string) => void;
} = {}): AgentOsDriver {
  const leases = new Map<string, LeaseState>();
  const warn = options.warn ?? (() => {});

  async function running(state: LeaseState): Promise<boolean> {
    if (state.nodePid === undefined) return false;
    try {
      const process: ProcessDescriptor = await state.vm.process.get(state.nodePid);
      return process.state === "running";
    } catch {
      return false;
    }
  }

  async function release(leaseId: string): Promise<void> {
    const state = leases.get(leaseId);
    if (!state) return;
    leases.delete(leaseId);
    if (state.nodePid !== undefined) {
      await state.vm.process.signal(state.nodePid, "SIGTERM").catch(() => {});
    }
    await state.vm.dispose();
  }

  return {
    async provision({ allocation, profile }) {
      const existing = leases.get(allocation.leaseId);
      if (existing) return;
      const vm = await AgentOs.create({
        allowedNodeBuiltins: [...OPENCLAW_AGENTOS_NODE_BUILTINS],
        permissions: {
          fs: "allow",
          childProcess: "allow",
          process: "allow",
          env: "allow",
          network: profile.network,
        },
        limits: {
          resources: {
            maxProcesses: 96,
            maxOpenFds: 512,
            maxSockets: 256,
            maxFilesystemBytes: profile.maxFilesystemBytes,
          },
          process: {
            pendingStdinBytes: 64 * 1024 * 1024,
            pendingEventCount: 10_000,
            pendingEventBytes: 64 * 1024 * 1024,
          },
          jsRuntime: {
            v8HeapLimitMb: profile.v8HeapLimitMb,
            cpuTimeLimitMs: 0,
            wallClockLimitMs: 0,
            importCacheMaterializeTimeoutMs: 120_000,
            syncRpcWaitTimeoutMs: 120_000,
          },
        },
        onLimitWarning: (warning) =>
          warn(
            `agentOS lease ${allocation.leaseId} is near ${warning.limit}: ${warning.fillPercent}%`,
          ),
      });
      leases.set(allocation.leaseId, { vm, profile });
    },

    async enrollNode({ allocation, enrollment, profile }) {
      enrollment.signal?.throwIfAborted();
      const state = leases.get(allocation.leaseId);
      if (!state) throw new Error("agentOS lease was not provisioned");
      if (state.bootstrapSha === enrollment.nodeBootstrap.sha256 && (await running(state))) return;

      if (state.nodePid !== undefined) {
        await state.vm.process.signal(state.nodePid, "SIGTERM").catch(() => {});
        delete state.nodePid;
      }

      const root = stateRoot(allocation.leaseId);
      const runtime = `${root}/runtime-${enrollment.nodeBootstrap.sha256}`;
      const archive = `${root}/openclaw.tgz`;
      const setupFile = `${root}/setup-code`;
      await state.vm.filesystem.mkdir(root, { recursive: true });

      if (!(await state.vm.filesystem.exists(`${runtime}/node_modules/openclaw/openclaw.mjs`))) {
        const bytes = await downloadBootstrap(enrollment.nodeBootstrap, enrollment.signal);
        await writeLargeFile(state.vm, archive, bytes);
        await state.vm.filesystem.mkdir(runtime, { recursive: true });
        await state.vm.filesystem.writeFile(
          `${runtime}/package.json`,
          JSON.stringify({ private: true, allowScripts: { [`file:${archive}`]: true } }),
        );
        const installed = await state.vm.javascript.npm.install(`file:${archive}`, {
          cwd: runtime,
          timeoutMs: profile.installTimeoutMs,
          env: { npm_config_audit: "false", npm_config_fund: "false" },
        });
        await ensureSucceeded(installed, "OpenClaw bootstrap installation");
      }

      const cli = `${runtime}/node_modules/openclaw/openclaw.mjs`;
      const patchedFiles = await applyOpenClawCompatibility(
        state.vm,
        `${runtime}/node_modules/openclaw`,
      );
      if (patchedFiles > 0) {
        warn(
          `agentOS lease ${allocation.leaseId} patched ${patchedFiles} OpenClaw file(s) for node:readline/promises compatibility`,
        );
      }
      const stateDir = `${root}/state`;
      await state.vm.filesystem.mkdir(stateDir, { recursive: true });
      for (const pluginId of new Set(enrollment.nodeBootstrap.enabledPluginIds)) {
        const enabled = await state.vm.process.execFile("node", [cli, "plugins", "enable", pluginId], {
          cwd: runtime,
          env: { OPENCLAW_STATE_DIR: stateDir },
          timeoutMs: 60_000,
        });
        await ensureSucceeded(enabled, `enabling OpenClaw plugin ${pluginId}`);
      }

      const args =
        enrollment.mode === "connect"
          ? ["connect", "--target-file", setupFile]
          : ["node", "run"];
      if (enrollment.mode === "connect") {
        await state.vm.filesystem.writeFile(setupFile, `${enrollment.setupCode}\n`);
      }
      enrollment.signal?.throwIfAborted();
      const process = await state.vm.process.spawn(
        "node",
        [cli, ...args, "--ephemeral", "--display-name", enrollment.displayName],
        {
          cwd: runtime,
          env: { OPENCLAW_STATE_DIR: stateDir },
          timeoutMs: 0,
          output: { retainEvents: true },
        },
      );
      state.nodePid = process.pid;
      state.bootstrapSha = enrollment.nodeBootstrap.sha256;
      await state.vm.filesystem.writeFile(
        `${root}/lease.json`,
        JSON.stringify({ pid: process.pid, bootstrapSha: state.bootstrapSha }),
      );
    },

    async inspect({ leaseId }): Promise<WorkerLeaseStatus> {
      const state = leases.get(leaseId);
      if (!state) return { status: "unknown" };
      return (await running(state)) ? { status: "active", sharedHost: false } : { status: "dormant" };
    },

    async destroy({ leaseId }) {
      await release(leaseId);
    },

    async dispose() {
      await Promise.allSettled([...leases.keys()].map((leaseId) => release(leaseId)));
    },
  };
}
