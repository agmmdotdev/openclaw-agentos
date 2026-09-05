import { describe, expect, it } from "vitest";
import { patchOpenClawSource } from "../src/compatibility.js";

describe("patchOpenClawSource", () => {
  it("aliases the unsupported promises subpath to AgentOS readline", () => {
    const result = patchOpenClawSource(
      'import readline from "node:readline/promises";\nimport { createInterface } from "node:readline/promises";',
    );

    expect(result.replacements).toBe(2);
    expect(result.source).toBe(
      'import readline from "node:readline";\nimport { createInterface } from "node:readline";',
    );
  });

  it("leaves compatible source untouched", () => {
    const source = 'import readline from "node:readline";';
    expect(patchOpenClawSource(source)).toEqual({ source, replacements: 0 });
  });
});
