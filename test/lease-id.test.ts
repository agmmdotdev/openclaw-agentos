import { describe, expect, it } from "vitest";
import { operationLeaseId } from "../src/lease-id.js";

describe("operationLeaseId", () => {
  it("is deterministic and provider-scoped", () => {
    expect(operationLeaseId("operation-1")).toBe(operationLeaseId("operation-1"));
    expect(operationLeaseId("operation-1")).toMatch(/^oc-aos-[a-f0-9]{24}$/);
    expect(operationLeaseId("operation-1")).not.toBe(operationLeaseId("operation-2"));
  });

  it("rejects empty operation ids", () => {
    expect(() => operationLeaseId("  ")).toThrow("must be non-empty");
  });
});
