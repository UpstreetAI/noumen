import { describe, it, expect } from "vitest";
import { createStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME } from "../tools/structured-output.js";
import type { OutputFormat, JsonSchemaOutputFormat, JsonObjectOutputFormat } from "../providers/types.js";

describe("StructuredOutput tool", () => {
  const schema: JsonSchemaOutputFormat = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    },
    name: "person",
    strict: true,
  };

  it("creates a tool with the correct name", () => {
    const tool = createStructuredOutputTool(schema);
    expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
  });

  it("returns stringified data in content", async () => {
    const tool = createStructuredOutputTool(schema);
    const result = await tool.call(
      { data: { name: "Alice", age: 30 } },
      {} as any,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string);
    expect(parsed).toEqual({ name: "Alice", age: 30 });
  });

  it("is read-only and concurrency-safe", () => {
    const tool = createStructuredOutputTool(schema);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isConcurrencySafe).toBe(true);
  });
});

describe("OutputFormat types", () => {
  it("json_schema format has all required fields", () => {
    const fmt: JsonSchemaOutputFormat = {
      type: "json_schema",
      schema: { type: "object", properties: {} },
    };
    expect(fmt.type).toBe("json_schema");
    expect(fmt.schema).toBeDefined();
  });

  it("json_object format is minimal", () => {
    const fmt: JsonObjectOutputFormat = { type: "json_object" };
    expect(fmt.type).toBe("json_object");
  });

  it("OutputFormat union works for both modes", () => {
    const formats: OutputFormat[] = [
      { type: "json_schema", schema: { type: "object" } },
      { type: "json_object" },
    ];
    expect(formats).toHaveLength(2);
    expect(formats[0].type).toBe("json_schema");
    expect(formats[1].type).toBe("json_object");
  });
});
