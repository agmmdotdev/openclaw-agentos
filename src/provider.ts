import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentOsProfile } from "./config.js";
import { operationLeaseId } from "./lease-id.js";
import type { AgentOsDriver } from "./types.js";

export function createAgentOsWorkerProvider(dependencies: {
  driver: AgentOsDriver;
}): WorkerProvider {
  const { driver } = dependencies;

  return {
    id: "agentos",
    supportedExecutionModes: ["worker-turn"],
    provisionBeforeInstallation: true,
    requiresNodeEnrollment: true,

    async resolveAllocation(profile, operationId) {
      parseAgentOsProfile(profile);
      return { leaseId: operationLeaseId(operationId), sharedHost: false };
    },

    resolveProvisionTimeoutMs(profile) {
      return parseAgentOsProfile(profile).installTimeoutMs + 120_000;
    },

    async provision(profile: WorkerProfile, operationId, options) {
      if (options?.executionMode && options.executionMode !== "worker-turn") {
        throw new WorkerProviderError("agentOS supports worker-turn execution only");
      }
      if (options?.machineClass) {
        throw new WorkerProviderError("agentOS does not expose machine classes");
      }
      if (!options?.beginNodeEnrollment) {
        throw new WorkerProviderError("agentOS node enrollment is unavailable");
      }

      const parsed = parseAgentOsProfile(profile);
      const allocation = {
        leaseId: operationLeaseId(operationId),
        sharedHost: false as const,
      };

      await driver.provision({ allocation, profile: parsed });
      const enrollment = await options.beginNodeEnrollment();

      try {
        await driver.enrollNode({ allocation, enrollment, profile: parsed });
        const deviceId = await enrollment.waitForDeviceId();
        return { ...allocation, node: { deviceId } };
      } catch (error) {
        if (enrollment.signal?.aborted) throw error;
        try {
          await driver.destroy({ leaseId: allocation.leaseId, profile: parsed });
        } catch (cleanupError) {
          throw WorkerProviderError.cleanupIndeterminate(
            allocation.leaseId,
            error,
            cleanupError,
          );
        }
        throw error;
      }
    },

    async inspect({ leaseId, profile }) {
      return driver.inspect({ leaseId, profile: parseAgentOsProfile(profile) });
    },

    async destroy({ leaseId, profile }) {
      await driver.destroy({ leaseId, profile: parseAgentOsProfile(profile) });
    },
  };
}
