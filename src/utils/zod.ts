/**
 * Zod integration utilities. Users bring their own `zod` dependency — these
 * helpers accept duck-typed schemas so we don't force a hard dependency.
 */

export type JsonSchemaType = Record<string, unknown>;

/**
 * Minimal interface matching Zod v4's safeParse return. Allows noumen to
 * validate tool input without depending on zod directly.
 */
export interface SafeParseResult {
  success: boolean;
  data?: unknown;
  error?: {
    issues: Array<{
      code: string;
      path: (string | number)[];
      message: string;
    }>;
  };
}

export interface ZodLikeSchema {
  safeParse(data: unknown): SafeParseResult;
}

const cache = new WeakMap<object, JsonSchemaType>();

/**
 * Convert a Zod v4 schema to JSON Schema. Caches by schema identity.
 * Requires `zod/v4` to be installed — calls its native `toJSONSchema`.
 */
export function zodToJsonSchema(schema: ZodLikeSchema): JsonSchemaType {
  const hit = cache.get(schema);
  if (hit) return hit;

  const zod = (schema as unknown as { _zod?: unknown })._zod
    ? schema
    : undefined;

  if (!zod) {
    throw new Error(
      "zodToJsonSchema requires a Zod v4 schema. Install zod and pass a z.object(…) schema.",
    );
  }

  let toJSONSchema: ((s: unknown) => JsonSchemaType) | undefined;
  try {
    // Dynamic import isn't possible synchronously, so we look for the
    // schema's own conversion method first (Zod v4 attaches _toJSONSchema).
    const sAny = schema as unknown as Record<string, unknown>;
    if (typeof sAny._toJSONSchema === "function") {
      const result = sAny._toJSONSchema() as JsonSchemaType;
      cache.set(schema, result);
      return result;
    }
    // Fallback: try the module-level toJSONSchema from zod/v4
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    toJSONSchema = (globalThis as unknown as Record<string, unknown>)
      .__noumen_toJSONSchema as typeof toJSONSchema;
  } catch {
    // not available
  }

  if (toJSONSchema) {
    const result = toJSONSchema(schema) as JsonSchemaType;
    cache.set(schema, result);
    return result;
  }

  throw new Error(
    "Could not convert Zod schema to JSON Schema. " +
      "Call `registerZodToJsonSchema(toJSONSchema)` from zod/v4 or upgrade to Zod v4.",
  );
}

/**
 * Register the `toJSONSchema` function from `zod/v4` so `zodToJsonSchema` can use it.
 *
 * ```ts
 * import { toJSONSchema } from "zod/v4";
 * import { registerZodToJsonSchema } from "noumen";
 * registerZodToJsonSchema(toJSONSchema);
 * ```
 */
export function registerZodToJsonSchema(
  fn: (schema: unknown) => JsonSchemaType,
): void {
  (globalThis as unknown as Record<string, unknown>).__noumen_toJSONSchema = fn;
}

/**
 * Format a Zod validation error into a human-readable string suitable
 * for feeding back to the model as a tool_result error.
 */
export function formatZodValidationError(
  toolName: string,
  issues: SafeParseResult["error"],
): string {
  if (!issues || !issues.issues.length) {
    return `${toolName}: validation failed with unknown error`;
  }

  const parts: string[] = [];

  const missing = issues.issues.filter(
    (i) => i.code === "invalid_type" && i.message.includes("required"),
  );
  const unrecognized = issues.issues.filter(
    (i) => i.code === "unrecognized_keys",
  );
  const other = issues.issues.filter(
    (i) =>
      !missing.includes(i) && !unrecognized.includes(i),
  );

  if (missing.length) {
    parts.push(
      `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.map((m) => formatPath(m.path)).join(", ")}`,
    );
  }
  if (unrecognized.length) {
    parts.push(
      `Unrecognized parameter${unrecognized.length > 1 ? "s" : ""}: ${unrecognized.map((u) => u.message).join(", ")}`,
    );
  }
  for (const issue of other) {
    const path = formatPath(issue.path);
    parts.push(`${path ? path + ": " : ""}${issue.message}`);
  }

  return `${toolName} failed due to the following ${parts.length > 1 ? "issues" : "issue"}:\n${parts.join("\n")}`;
}

function formatPath(path: (string | number)[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i > 0 ? `.${p}` : p))
    .join("");
}
