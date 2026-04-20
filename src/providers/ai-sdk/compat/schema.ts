/**
 * JSON Schema shims for AI SDK provider compatibility.
 *
 * Ported from mastra (`packages/core/src/stream/aisdk/v5/compat/prepare-tools.ts`).
 * Zod v4 `z.any()` serializes to a schema with no `type` field, which OpenAI
 * and other providers reject. `fixTypelessProperties` walks the schema and
 * injects a permissive type union wherever a property omits `type`, `$ref`,
 * `anyOf`, `oneOf`, and `allOf`.
 */

const PERMISSIVE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "null",
] as const;

export function fixTypelessProperties(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return schema;

  const result: Record<string, unknown> = { ...schema };

  if (
    result.properties &&
    typeof result.properties === "object" &&
    !Array.isArray(result.properties)
  ) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return [key, value];
        }

        const propSchema = value as Record<string, unknown>;
        const hasType = "type" in propSchema;
        const hasRef = "$ref" in propSchema;
        const hasAnyOf = "anyOf" in propSchema;
        const hasOneOf = "oneOf" in propSchema;
        const hasAllOf = "allOf" in propSchema;

        if (!hasType && !hasRef && !hasAnyOf && !hasOneOf && !hasAllOf) {
          const { items: _items, ...rest } = propSchema;
          return [key, { ...rest, type: [...PERMISSIVE_TYPES] }];
        }

        return [key, fixTypelessProperties(propSchema)];
      }),
    );
  }

  if (result.items) {
    if (Array.isArray(result.items)) {
      result.items = (result.items as Record<string, unknown>[]).map((item) =>
        fixTypelessProperties(item),
      );
    } else if (typeof result.items === "object") {
      result.items = fixTypelessProperties(result.items as Record<string, unknown>);
    }
  }

  return result;
}
