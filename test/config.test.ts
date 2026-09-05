import { describe, expect, it } from "vitest";
import { parseAgentOsProfile } from "../src/config.js";

describe("parseAgentOsProfile", () => {
  it("supplies conservative OpenClaw defaults", () => {
    expect(parseAgentOsProfile({})).toEqual({
      maxFilesystemBytes: 1024 * 1024 * 1024,
      v8HeapLimitMb: 256,
      installTimeoutMs: 600_000,
      network: "allow",
    });
  });

  it("rejects invalid limits", () => {
    expect(() => parseAgentOsProfile({ v8HeapLimitMb: 0 })).toThrow("v8HeapLimitMb");
    expect(() => parseAgentOsProfile({ network: "sometimes" })).toThrow("network");
  });
});
