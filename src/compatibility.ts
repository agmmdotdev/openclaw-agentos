import type { AgentOs } from "@rivet-dev/agentos-core";

const READLINE_PROMISES_SPECIFIER = "node:readline/promises";
const READLINE_SPECIFIER = "node:readline";

/**
 * Node builtins imported by the pinned OpenClaw worker after applying the
 * temporary readline/promises rewrite. Keeping this explicit makes AgentOS's
 * runtime policy match the artifact we audited instead of silently relying on
 * its smaller default allow-list.
 */
export const OPENCLAW_AGENTOS_NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "crypto",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/win32",
  "perf_hooks",
  "process",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
] as const;

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
