import { createHash } from "node:crypto";

const PREFIX = "oc-aos-";

export function operationLeaseId(operationId: string): string {
  const normalized = operationId.trim();
  if (!normalized) {
    throw new TypeError("agentOS operation id must be non-empty");
  }
  return `${PREFIX}${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}
