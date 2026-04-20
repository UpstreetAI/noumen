import { describe, it, expect } from "vitest";
import {
  sanitizeToolCallInput,
  tryRepairJson,
  parseToolCallJson,
} from "../providers/ai-sdk/compat/json-repair.js";
import { fixTypelessProperties } from "../providers/ai-sdk/compat/schema.js";
import { inferProviderFamily } from "../providers/ai-sdk/provider-family.js";
import { translateRequest } from "../providers/ai-sdk/request.js";
import { translateStream, type AiSdkStreamPart } from "../providers/ai-sdk/stream.js";
import type { ChatParams } from "../providers/types.js";

async function drainToText(parts: AiSdkStreamPart[]): Promise<string> {
  const stream = new ReadableStream<AiSdkStreamPart>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  let out = "";
  for await (const c of translateStream(stream, "m")) {
    out += c.choices[0].delta.content ?? "";
  }
  return out;
}

describe("sanitizeToolCallInput", () => {
  it("passes valid JSON through unchanged (preserving <|...|> inside strings)", () => {
    const valid = '{"chant":"<|magic|>"}';
    expect(sanitizeToolCallInput(valid)).toBe(valid);
  });

  it("strips trailing <|call|> / <|endoftext|> only when JSON is invalid", () => {
    expect(sanitizeToolCallInput('{"a":1}<|call|>')).toBe('{"a":1}');
    expect(sanitizeToolCallInput('<|start|>{"a":1}<|endoftext|>')).toBe('{"a":1}');
  });
});

describe("tryRepairJson", () => {
  it("fixes missing quote before property name", () => {
    expect(tryRepairJson('{"a":"b",c":"d"}')).toEqual({ a: "b", c: "d" });
  });

  it("quotes unquoted property names", () => {
    expect(tryRepairJson('{command:"ls"}')).toEqual({ command: "ls" });
  });

  it("converts single quotes to double quotes", () => {
    expect(tryRepairJson("{'a':'b'}")).toEqual({ a: "b" });
  });

  it("drops trailing commas", () => {
    expect(tryRepairJson('{"a":1,}')).toEqual({ a: 1 });
    expect(tryRepairJson('{"arr":[1,2,]}')).toEqual({ arr: [1, 2] });
  });

  it("returns null on unrecoverable input", () => {
    expect(tryRepairJson("<<<not json>>>")).toBeNull();
  });
});

describe("parseToolCallJson", () => {
  it("returns undefined for empty input", () => {
    expect(parseToolCallJson("")).toBeUndefined();
  });

  it("parses valid JSON directly", () => {
    expect(parseToolCallJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("falls back to repair on malformed JSON", () => {
    expect(parseToolCallJson("{a:1}")).toEqual({ a: 1 });
  });

  it("returns null on total failure", () => {
    expect(parseToolCallJson("not json at all")).toBeNull();
  });
});

describe("fixTypelessProperties", () => {
  it("injects permissive union for schemaless props", () => {
    const out = fixTypelessProperties({
      type: "object",
      properties: {
        anything: {},
      },
    });
    const props = (out.properties as Record<string, { type: string[] }>).anything;
    expect(props.type).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "null",
    ]);
  });

  it("leaves typed props untouched", () => {
    const out = fixTypelessProperties({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect((out.properties as Record<string, unknown>).a).toEqual({ type: "string" });
  });

  it("respects $ref / anyOf / oneOf / allOf", () => {
    const out = fixTypelessProperties({
      type: "object",
      properties: {
        r: { $ref: "#/defs/X" },
        a: { anyOf: [{ type: "string" }] },
        o: { oneOf: [{ type: "number" }] },
        al: { allOf: [{ type: "boolean" }] },
      },
    });
    const props = out.properties as Record<string, unknown>;
    expect(props.r).toEqual({ $ref: "#/defs/X" });
    expect(props.a).toEqual({ anyOf: [{ type: "string" }] });
    expect(props.o).toEqual({ oneOf: [{ type: "number" }] });
    expect(props.al).toEqual({ allOf: [{ type: "boolean" }] });
  });

  it("recurses into nested properties", () => {
    const out = fixTypelessProperties({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { inner: {} },
        },
      },
    });
    const nested = (
      (out.properties as Record<string, { properties: Record<string, { type: string[] }> }>)
        .outer.properties.inner
    );
    expect(nested.type).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "null",
    ]);
  });

  it("recurses into array items", () => {
    const out = fixTypelessProperties({
      type: "object",
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
            properties: { leaf: {} },
          },
        },
      },
    });
    const item =
      ((out.properties as Record<string, { items: { properties: Record<string, { type: string[] }> } }>)
        .arr.items.properties.leaf);
    expect(item.type).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "null",
    ]);
  });
});

describe("inferProviderFamily", () => {
  const cases: Array<[string, string]> = [
    ["anthropic.messages", "anthropic"],
    ["amazon-bedrock", "anthropic"],
    ["bedrock", "anthropic"],
    ["google-vertex.anthropic", "anthropic"],
    ["google.generative-ai", "google"],
    ["google", "google"],
    ["openai.chat", "openai"],
    ["openai.responses", "openai"],
    ["openrouter.chat", "openai"],
    ["ollama.chat", "openai"],
    ["custom.chat", "openai"],
    ["custom.responses", "openai"],
    ["totally-unknown-provider", "unknown"],
  ];

  for (const [input, expected] of cases) {
    it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      expect(inferProviderFamily(input)).toBe(expected);
    });
  }
});

describe("translateRequest — thinking budget edge cases", () => {
  const msgs: ChatParams["messages"] = [{ role: "user", content: "hi" }];

  it("clamps budgetTokens to max_tokens - 1 on anthropic (matches legacy guarantee)", () => {
    const call = translateRequest(
      {
        model: "claude-sonnet-4",
        messages: msgs,
        max_tokens: 1024,
        thinking: { type: "enabled", budgetTokens: 2048 },
      },
      { providerFamily: "anthropic" },
    );
    const thinking = (call.providerOptions!.anthropic as {
      thinking: { budgetTokens: number };
    }).thinking;
    expect(thinking.budgetTokens).toBe(1023);
    // And the mandatory invariant: max_tokens > budget_tokens.
    expect(call.maxOutputTokens!).toBeGreaterThan(thinking.budgetTokens);
  });

  it("leaves budgetTokens untouched when max_tokens is not set", () => {
    const call = translateRequest(
      {
        model: "claude-sonnet-4",
        messages: msgs,
        thinking: { type: "enabled", budgetTokens: 4096 },
      },
      { providerFamily: "anthropic" },
    );
    const thinking = (call.providerOptions!.anthropic as {
      thinking: { budgetTokens: number };
    }).thinking;
    expect(thinking.budgetTokens).toBe(4096);
  });

  it("thinking enabled but budgetTokens = 0 is treated as disabled", () => {
    const call = translateRequest(
      {
        model: "claude-sonnet-4",
        messages: msgs,
        thinking: { type: "enabled", budgetTokens: 0 },
      },
      { providerFamily: "anthropic" },
    );
    expect(call.providerOptions?.anthropic).toBeUndefined();
  });
});

describe("translateStream — accumulation corner cases", () => {
  it("tool-call after streamed input is suppressed (no double-count)", async () => {
    const stream = new ReadableStream<AiSdkStreamPart>({
      start(controller) {
        controller.enqueue({ type: "tool-input-start", id: "c1", toolName: "T" });
        controller.enqueue({ type: "tool-input-delta", id: "c1", delta: '{"a":1}' });
        controller.enqueue({ type: "tool-input-end", id: "c1" });
        controller.enqueue({
          type: "tool-call",
          toolCallId: "c1",
          toolName: "T",
          input: '{"a":1}',
        });
        controller.enqueue({
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        controller.close();
      },
    });

    let seenStart = false;
    let argChunks = 0;
    let finalCallChunks = 0;
    for await (const chunk of translateStream(stream, "m")) {
      for (const t of chunk.choices[0].delta.tool_calls ?? []) {
        if (t.function?.name) seenStart = true;
        else if (t.function?.arguments) argChunks++;
        if (t.id === "c1" && t.function?.name && t.function.arguments) {
          finalCallChunks++;
        }
      }
    }
    expect(seenStart).toBe(true);
    expect(argChunks).toBeGreaterThan(0);
    // The terminal `tool-call` part must NOT have produced a second chunk
    // carrying the full name+arguments (that would double-count on the
    // downstream accumulator).
    expect(finalCallChunks).toBe(0);
  });

  it("text accumulates back into the expected string", async () => {
    const text = await drainToText([
      { type: "text-delta", id: "t", delta: "Hel" },
      { type: "text-delta", id: "t", delta: "lo," },
      { type: "text-delta", id: "t", delta: " world" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(text).toBe("Hello, world");
  });
});
