import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_FILESYSTEM_BYTES = 1024 * 1024 * 1024;
const DEFAULT_HEAP_MB = 256;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type AgentOsProfile = {
  maxFilesystemBytes: number;
  v8HeapLimitMb: number;
  installTimeoutMs: number;
  network: "allow" | "deny";
};

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`agentOS ${name} must be a positive integer`);
  }
  return value as number;
}

export function parseAgentOsProfile(profile: WorkerProfile): AgentOsProfile {
  const network = profile.network ?? "allow";
  if (network !== "allow" && network !== "deny") {
    throw new TypeError('agentOS network must be "allow" or "deny"');
  }
  return {
    maxFilesystemBytes: positiveInteger(
      profile.maxFilesystemBytes,
      DEFAULT_FILESYSTEM_BYTES,
      "maxFilesystemBytes",
    ),
    v8HeapLimitMb: positiveInteger(profile.v8HeapLimitMb, DEFAULT_HEAP_MB, "v8HeapLimitMb"),
    installTimeoutMs: positiveInteger(
      profile.installTimeoutMs,
      DEFAULT_INSTALL_TIMEOUT_MS,
      "installTimeoutMs",
    ),
    network,
  };
}
