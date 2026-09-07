// Runtime schema adapters do not construct channel or agent policy schemas.
import type { ZodTypeAny } from "zod";
import {
  parseJsonSchemaIssuePath,
  validateJsonSchemaValue,
} from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import type {
  ChannelConfigRuntimeIssue,
  ChannelConfigRuntimeParseResult,
  ChannelConfigSchema,
  ChannelConfigUiHint,
} from "./types.config.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type BuildChannelConfigSchemaOptions = {
  uiHints?: Record<string, ChannelConfigUiHint>;
  /** Select input mode when transforms must expose accepted config values to editors. */
  jsonSchemaMode?: "input" | "output";
};

type BuildJsonChannelConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigSchema["runtime"];
};

function cloneRuntimeIssue(issue: unknown): ChannelConfigRuntimeIssue {
  const record = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const path = Array.isArray(record.path)
    ? record.path.filter((segment): segment is string | number => {
        const kind = typeof segment;
        return kind === "string" || kind === "number";
      })
    : undefined;
  return {
    ...record,
    ...(path ? { path } : {}),
  };
}

function safeParseRuntimeSchema(
  schema: ZodTypeAny,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
  };
}

function safeParseJsonSchema(
  schema: JsonSchemaObject,
  cacheKey: string,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value,
    applyDefaults: true,
  });
  if (result.ok) {
    return { success: true, data: result.value };
  }
  return {
    success: false,
    issues: result.errors.map((issue) => ({
      path: parseJsonSchemaIssuePath(issue.path),
      message: issue.message,
    })),
  };
}

/** Build a channel config schema from JSON Schema with runtime validation/default support. */
export function buildJsonChannelConfigSchema(
  schema: JsonSchemaObject,
  options?: BuildJsonChannelConfigSchemaOptions,
): ChannelConfigSchema {
  return {
    schema,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: options?.runtime ?? {
      safeParse: (value) =>
        safeParseJsonSchema(schema, options?.cacheKey ?? "channel-config-schema:json", value),
    },
  };
}

/** Build a channel config schema from Zod, exporting JSON Schema when available. */
export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: BuildChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        ...(options?.jsonSchemaMode ? { io: options.jsonSchemaMode } : {}),
        unrepresentable: "any",
      }) as JsonSchemaObject,
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      runtime: {
        safeParse: (value) => safeParseRuntimeSchema(schema, value),
      },
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas,
  // where `.toJSONSchema()` is unavailable.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse: (value) => safeParseRuntimeSchema(schema, value),
    },
  };
}

/** Return a channel config schema for channels that intentionally accept no config keys. */
export function emptyChannelConfigSchema(): ChannelConfigSchema {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    runtime: {
      safeParse(value) {
        if (value === undefined) {
          return { success: true, data: undefined };
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return {
            success: false,
            issues: [{ path: [], message: "expected config object" }],
          };
        }
        if (Object.keys(value as Record<string, unknown>).length > 0) {
          return {
            success: false,
            issues: [{ path: [], message: "config must be empty" }],
          };
        }
        return { success: true, data: value };
      },
    },
  };
}
