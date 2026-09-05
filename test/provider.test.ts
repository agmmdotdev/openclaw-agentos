import { describe, expect, it, vi } from "vitest";
import { createAgentOsWorkerProvider } from "../src/provider.js";
import type { AgentOsDriver, WorkerNodeEnrollment } from "../src/types.js";

function harness() {
  const driver: AgentOsDriver = {
    provision: vi.fn(async () => {}),
    enrollNode: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ status: "active" as const, sharedHost: false })),
    destroy: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { driver, provider: createAgentOsWorkerProvider({ driver }) };
}

function enrollment(): WorkerNodeEnrollment {
  return {
    mode: "connect",
    setupCode: "secret",
    setupId: "setup-1",
    openclawVersion: "2026.8.1",
    displayName: "agentos-worker",
    nodeBootstrap: {
      url: "https://gateway.invalid/bootstrap",
      token: "bootstrap-token",
      sha256: "a".repeat(64),
      bytes: 1024,
      openclawVersion: "2026.8.1",
      enabledPluginIds: [],
    },
    waitForDeviceId: vi.fn(async () => "device-1"),
  };
}

describe("agentOS WorkerProvider", () => {
  it("advertises worker-turn node enrollment", () => {
    const { provider } = harness();
    expect(provider.supportedExecutionModes).toEqual(["worker-turn"]);
    expect(provider.requiresNodeEnrollment).toBe(true);
  });

  it("provisions, enrolls, and returns a node lease", async () => {
    const { driver, provider } = harness();
    const nodeEnrollment = enrollment();
    const lease = await provider.provision({}, "operation-1", {
      executionMode: "worker-turn",
      beginNodeEnrollment: async () => nodeEnrollment,
    });
    expect(driver.provision).toHaveBeenCalledOnce();
    expect(driver.enrollNode).toHaveBeenCalledOnce();
    expect(lease.node).toEqual({ deviceId: "device-1" });
    expect(lease.sharedHost).toBe(false);
  });

  it("cleans up when enrollment fails", async () => {
    const { driver, provider } = harness();
    vi.mocked(driver.enrollNode).mockRejectedValueOnce(new Error("enrollment failed"));
    await expect(
      provider.provision({}, "operation-1", {
        beginNodeEnrollment: async () => enrollment(),
      }),
    ).rejects.toThrow("enrollment failed");
    expect(driver.destroy).toHaveBeenCalledOnce();
  });

  it("rejects remote-exec before allocating", async () => {
    const { driver, provider } = harness();
    await expect(
      provider.provision({}, "operation-1", {
        executionMode: "remote-exec",
        beginNodeEnrollment: async () => enrollment(),
      }),
    ).rejects.toThrow("worker-turn");
    expect(driver.provision).not.toHaveBeenCalled();
  });
});
