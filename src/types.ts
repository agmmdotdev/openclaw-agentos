import type {
  WorkerLeaseStatus,
  WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import type { AgentOsProfile } from "./config.js";

export type WorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

export type AgentOsAllocation = {
  leaseId: string;
  sharedHost: false;
};

export interface AgentOsDriver {
  provision(input: {
    allocation: AgentOsAllocation;
    profile: AgentOsProfile;
  }): Promise<void>;

  enrollNode(input: {
    allocation: AgentOsAllocation;
    enrollment: WorkerNodeEnrollment;
    profile: AgentOsProfile;
  }): Promise<void>;

  inspect(input: {
    leaseId: string;
    profile: AgentOsProfile;
  }): Promise<WorkerLeaseStatus>;

  destroy(input: {
    leaseId: string;
    profile: AgentOsProfile;
  }): Promise<void>;

  dispose(): Promise<void>;
}
