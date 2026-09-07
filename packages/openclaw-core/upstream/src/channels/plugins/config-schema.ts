/**
 * Channel config schema helpers.
 *
 * Builds common zod/JSON schema shapes and parses runtime config issues for channel plugins.
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { ToolPolicySchema } from "../../config/zod-schema.agent-runtime.js";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
export {
  buildChannelConfigSchema,
  buildJsonChannelConfigSchema,
  emptyChannelConfigSchema,
} from "./config-schema-runtime.js";

type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};

/** Shared allowlist entry shape for channel sender/user ids. */
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
/** Optional allowlist array used by channel config schema builders. */
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

/** Canonical per-group/room channel policy shape. */
export const ChannelGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: AllowFromListSchema,
    systemPrompt: z.string().optional(),
  })
  .strict();

type ChannelGroupEntryField = keyof typeof ChannelGroupEntrySchema.shape;

/** Extend the canonical group/room policy shape with channel-owned fields. */
export function buildGroupEntrySchema<
  T extends ZodRawShape = Record<never, never>,
  const TOmit extends readonly ChannelGroupEntryField[] = [],
>(extraShape?: T, options?: { omit?: TOmit }) {
  const omitted = new Set<ChannelGroupEntryField>(options?.omit ?? []);
  const baseShape = Object.fromEntries(
    Object.entries(ChannelGroupEntrySchema.shape).filter(
      ([key]) => !omitted.has(key as ChannelGroupEntryField),
    ),
  ) as Omit<typeof ChannelGroupEntrySchema.shape, TOmit[number]>;
  return z.object({ ...baseShape, ...(extraShape ?? ({} as T)) }).strict();
}

/** Build the common nested DM config block used by channel account schemas. */
export function buildNestedDmConfigSchema(extraShape?: ZodRawShape) {
  const baseShape = {
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

/** Add `accounts` catchall and `defaultAccount` fields to a channel account schema. */
export function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(
  accountSchema: T,
): T {
  return buildMultiAccountChannelSchema(accountSchema as unknown as z.ZodObject, {
    accountsMode: "catchall",
  }) as unknown as T;
}

type MultiAccountSchemaBaseOptions<TAccount extends ZodTypeAny, TOptional extends boolean> = {
  accountSchema?: TAccount;
  accountsMode?: "record" | "catchall";
  optionalAccount?: TOptional;
};

type MultiAccountRefinement<T extends z.ZodObject> = (
  value: z.output<T>,
  ctx: z.RefinementCtx,
) => void | Promise<void>;

type MultiAccountSchemaOptions<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny,
  TOptional extends boolean,
> =
  | (MultiAccountSchemaBaseOptions<TAccount, TOptional> & { refine?: undefined })
  | (MultiAccountSchemaBaseOptions<T, TOptional> & { refine: MultiAccountRefinement<T> });

type OptionalAccountValue<T, TOptional extends boolean> = TOptional extends true
  ? T | undefined
  : T;

type MultiAccountEnvelopeShape<TAccount extends ZodTypeAny, TOptional extends boolean> = {
  accounts: z.ZodOptional<
    z.ZodType<
      Record<string, OptionalAccountValue<z.output<TAccount>, TOptional>>,
      Record<string, OptionalAccountValue<z.input<TAccount>, TOptional>>
    >
  >;
  defaultAccount: z.ZodOptional<z.ZodString>;
};

type MultiAccountChannelSchema<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny,
  TOptional extends boolean,
> = z.ZodObject<z.util.Extend<T["shape"], MultiAccountEnvelopeShape<TAccount, TOptional>>>;

/** Add the standard accounts/defaultAccount envelope and optional shared account/root refinement. */
export function buildMultiAccountChannelSchema<
  T extends z.ZodObject,
  TAccount extends ZodTypeAny = T,
  TOptional extends boolean = false,
>(
  baseSchema: T,
  options: MultiAccountSchemaOptions<T, TAccount, TOptional> = {},
): MultiAccountChannelSchema<T, TAccount, TOptional> {
  const refine = options.refine;
  const rawAccountSchema = options.accountSchema ?? baseSchema;
  const accountSchema = refine
    ? (rawAccountSchema as T).superRefine((value, ctx) => {
        return refine(value, ctx as z.RefinementCtx);
      })
    : rawAccountSchema;
  const accountValueSchema = options.optionalAccount ? accountSchema.optional() : accountSchema;
  const accountsSchema =
    options.accountsMode === "catchall"
      ? z.object({}).catchall(accountValueSchema).optional()
      : z.record(z.string(), accountValueSchema).optional();
  const channelSchema = baseSchema.extend({
    accounts: accountsSchema,
    defaultAccount: z.string().optional(),
  });
  return (refine
    ? channelSchema.superRefine((value, ctx) => {
        // Generic Zod extension widens the callback value; the runtime value and context stay intact.
        return refine(value as z.output<T>, ctx as z.RefinementCtx);
      })
    : channelSchema) as unknown as MultiAccountChannelSchema<T, TAccount, TOptional>;
}
