import { createHash } from "node:crypto";
import type { WorkerNodeEnrollment } from "./types.js";

const MAX_BOOTSTRAP_BYTES = 25 * 1024 * 1024;

export async function downloadBootstrap(
  bootstrap: WorkerNodeEnrollment["nodeBootstrap"],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (bootstrap.bytes <= 0 || bootstrap.bytes > MAX_BOOTSTRAP_BYTES) {
    throw new Error(`OpenClaw bootstrap size ${bootstrap.bytes} is outside the 25 MiB limit`);
  }
  if (bootstrap.tlsFingerprint) {
    throw new Error(
      "TLS-pinned private bootstrap URLs are not supported by the embedded agentOS driver yet",
    );
  }

  const url = new URL(bootstrap.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OpenClaw bootstrap URL is invalid");
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${bootstrap.token}` },
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`OpenClaw bootstrap download failed with HTTP ${response.status}`);
  }
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== bootstrap.bytes) {
    throw new Error("OpenClaw bootstrap content length does not match its declaration");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== bootstrap.bytes) {
    throw new Error("OpenClaw bootstrap byte length does not match its declaration");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== bootstrap.sha256) {
    throw new Error("OpenClaw bootstrap SHA-256 verification failed");
  }
  return bytes;
}
