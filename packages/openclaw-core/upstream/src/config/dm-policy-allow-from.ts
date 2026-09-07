import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/**
 * Closed set of sender-policy/allowFrom dependency violations. Both cases drop
 * every inbound DM at runtime, so callers surface them as config problems.
 */
export type DmPolicyAllowFromViolation = "open_requires_wildcard" | "allowlist_requires_entries";

/**
 * Canonical cross-field check for dmPolicy vs allowFrom. This is the single
 * source of truth shared by the Zod schema refinements and the CLI config
 * validator so the rule cannot drift between the two surfaces.
 */
export const evaluateDmPolicyAllowFromDependency = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
}): DmPolicyAllowFromViolation | null => {
  const allow = normalizeStringEntries(params.allowFrom);
  if (params.policy === "open" && !allow.includes("*")) {
    return "open_requires_wildcard";
  }
  if (params.policy === "allowlist" && allow.length === 0) {
    return "allowlist_requires_entries";
  }
  return null;
};
