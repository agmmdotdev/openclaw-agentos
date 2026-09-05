import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { AgentOs } from "@rivet-dev/agentos-core";

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

export async function writeLargeFile(
  vm: AgentOs,
  path: string,
  bytes: Uint8Array,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new TypeError("chunkBytes must be a positive integer");
  }
  await vm.filesystem.mkdir(posix.dirname(path), { recursive: true });
  if (bytes.byteLength <= chunkBytes) {
    await vm.filesystem.writeFile(path, bytes);
    return;
  }

  const uploadId = randomUUID();
  const stagedPath = `${path}.upload-${uploadId}`;
  const parts: string[] = [];
  try {
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkBytes, index++) {
      const part = `${stagedPath}.part-${index}`;
      await vm.filesystem.writeFile(
        part,
        bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)),
      );
      parts.push(part);
    }

    const source = [
      'const fs = require("node:fs");',
      `const parts = ${JSON.stringify(parts)};`,
      `const staged = ${JSON.stringify(stagedPath)};`,
      `const target = ${JSON.stringify(path)};`,
      'const fd = fs.openSync(staged, "wx", 0o600);',
      "try {",
      "  for (const part of parts) fs.writeSync(fd, fs.readFileSync(part));",
      "} finally { fs.closeSync(fd); }",
      "fs.renameSync(staged, target);",
      "for (const part of parts) fs.unlinkSync(part);",
    ].join("\n");
    const result = await vm.process.execFile("node", ["-e", source], {
      timeoutMs: 120_000,
    });
    if (result.outcome !== "succeeded" || result.exitCode !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || result.outcome;
      throw new Error(`agentOS staged file assembly failed: ${detail}`);
    }
  } catch (error) {
    await Promise.allSettled([
      vm.filesystem.remove(stagedPath),
      ...parts.map((part) => vm.filesystem.remove(part)),
    ]);
    throw error;
  }
}
