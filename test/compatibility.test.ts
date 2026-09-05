import { describe, expect, it } from "vitest";
import {
  OPENCLAW_AGENTOS_NODE_BUILTINS,
  patchOpenClawSource,
} from "../src/compatibility.js";

describe("OPENCLAW_AGENTOS_NODE_BUILTINS", () => {
  it("matches the audited worker policy after the temporary readline rewrite", () => {
    expect(OPENCLAW_AGENTOS_NODE_BUILTINS).toHaveLength(36);
    expect(OPENCLAW_AGENTOS_NODE_BUILTINS).toContain("crypto");
    expect(OPENCLAW_AGENTOS_NODE_BUILTINS).toContain("worker_threads");
    expect(OPENCLAW_AGENTOS_NODE_BUILTINS).not.toContain("readline/promises");
  });
});

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
