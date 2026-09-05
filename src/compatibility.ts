import type { AgentOs } from "@rivet-dev/agentos-core";

const READLINE_PROMISES_SPECIFIER = "node:readline/promises";
const READLINE_SPECIFIER = "node:readline";

const patchScript = String.raw`
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
let patchedFiles = 0;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(file);
      continue;
    }
    if (!/\.(?:c|m)?js$/.test(entry.name)) continue;
    const before = await readFile(file, "utf8");
    const after = before.replaceAll("node:readline/promises", "node:readline");
    if (after === before) continue;
    await writeFile(file, after);
    patchedFiles += 1;
  }
}

await visit(root);
console.log(JSON.stringify({ patchedFiles }));
`;

export function patchOpenClawSource(source: string): {
  source: string;
  replacements: number;
} {
  const pieces = source.split(READLINE_PROMISES_SPECIFIER);
  return {
    source: pieces.join(READLINE_SPECIFIER),
    replacements: pieces.length - 1,
  };
}

export async function applyOpenClawCompatibility(
  vm: AgentOs,
  packageRoot: string,
): Promise<number> {
  const scriptPath = `${packageRoot}/.openclaw-agentos-compat.mjs`;
  await vm.filesystem.writeFile(scriptPath, patchScript);
  try {
    const result = await vm.process.execFile("node", [scriptPath, packageRoot], {
      cwd: packageRoot,
      timeoutMs: 120_000,
      output: { capture: "all" },
    });
    if (result.outcome !== "succeeded" || result.exitCode !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || result.outcome;
      throw new Error(`OpenClaw compatibility patch failed: ${detail}`);
    }
    const lastLine = result.stdout?.trim().split("\n").at(-1);
    const parsed = lastLine ? (JSON.parse(lastLine) as { patchedFiles?: unknown }) : {};
    if (!Number.isSafeInteger(parsed.patchedFiles) || (parsed.patchedFiles as number) < 0) {
      throw new Error("OpenClaw compatibility patch returned an invalid result");
    }
    return parsed.patchedFiles as number;
  } finally {
    await vm.filesystem.remove(scriptPath).catch(() => {});
  }
}
