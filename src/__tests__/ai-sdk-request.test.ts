import { describe, it, expect } from "vitest";
import { translateRequest } from "../providers/ai-sdk/request.js";
import type { ChatParams, ToolDefinition } from "../providers/types.js";

const baseParams: ChatParams = {
  model: "gpt-5",
  messages: [{ role: "user", content: "hello" }],
};

describe("translateRequest — prompt conversion", () => {
  it("hoists params.system into a leading system message", () => {
    const call = translateRequest(
      { ...baseParams, system: "you are helpful" },
      { providerFamily: "openai" },
    );
    expect(call.prompt[0]).toEqual({
      role: "system",
      content: "you are helpful",
    });
  });

  it("drops conversation-level system messages (handled via params.system)", () => {
    const call = translateRequest(
      {
        ...baseParams,
        system: "top",
        messages: [
          { role: "system", content: "ignore me" } as ChatParams["messages"][number],
          { role: "user", content: "hi" },
        ],
      },
      { providerFamily: "openai" },
    );
    const systemCount = call.prompt.filter((p) => p.role === "system").length;
    expect(systemCount).toBe(1);
    expect(call.prompt[0]).toMatchObject({ role: "system", content: "top" });
  });

  it("converts assistant tool_calls into tool-call parts with parsed JSON input", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "do X" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "DoX", arguments: '{"a":1,"b":"two"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "tc1", content: "ok" },
        ],
      },
      { providerFamily: "openai" },
    );
    const assistant = call.prompt.find((p) => p.role === "assistant");
    expect(assistant).toBeDefined();
    const toolCallPart = (assistant!.content as Array<{ type: string }>).find(
      (c) => c.type === "tool-call",
    ) as unknown as { input: unknown; toolName: string; toolCallId: string; type: string };
    expect(toolCallPart).toEqual({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "DoX",
      input: { a: 1, b: "two" },
    });
  });

  it("emits tool-result with content array when the tool content is multi-part", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "do" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "T", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "tc1",
            content: [
              { type: "text", text: "hi" },
              { type: "image", data: "base64data", media_type: "image/png" },
            ],
          },
        ],
      },
      { providerFamily: "openai" },
    );
    const toolMsg = call.prompt.find((m) => m.role === "tool")!;
    const result = (toolMsg.content as Array<{ output: unknown }>)[0].output as {
      type: string;
      value: unknown[];
    };
    expect(result.type).toBe("content");
    expect(result.value).toHaveLength(2);
  });

  it("error tool-result reduces to text-only error-text output", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "do" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "T", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "tc1",
            isError: true,
            content: [
              { type: "text", text: "Boom" },
              { type: "image", data: "base64data", media_type: "image/png" },
            ],
          },
        ],
      },
      { providerFamily: "openai" },
    );
    const toolMsg = call.prompt.find((m) => m.role === "tool")!;
    const out = (toolMsg.content as Array<{ output: unknown }>)[0].output as {
      type: string;
      value: string;
    };
    expect(out).toEqual({ type: "error-text", value: "Boom" });
  });
});

describe("translateRequest — Anthropic-specific behavior", () => {
  it("forwards thinking signature on assistant reasoning via providerOptions.anthropic", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "sure",
            thinking_content: "internal plan",
            thinking_signature: "sig-abc",
          } as ChatParams["messages"][number],
        ],
      },
      { providerFamily: "anthropic" },
    );
    const assistant = call.prompt.find((m) => m.role === "assistant")!;
    const reasoning = (assistant.content as Array<{ type: string; providerOptions?: unknown }>).find(
      (c) => c.type === "reasoning",
    ) as unknown as { text: string; providerOptions: { anthropic: { signature: string } } };
    expect(reasoning.text).toBe("internal plan");
    expect(reasoning.providerOptions.anthropic.signature).toBe("sig-abc");
  });

  it("drops reasoning parts on non-Anthropic providers", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "sure",
            thinking_content: "internal plan",
            thinking_signature: "sig-abc",
          } as ChatParams["messages"][number],
        ],
      },
      { providerFamily: "openai" },
    );
    const assistant = call.prompt.find((m) => m.role === "assistant")!;
    const reasoningParts = (
      assistant.content as Array<{ type: string }>
    ).filter((c) => c.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
  });

  it("places a single cache breakpoint on the last user message when cacheConfig enabled", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [
          { role: "user", content: "turn 1" },
          { role: "assistant", content: "ok" } as ChatParams["messages"][number],
          { role: "user", content: "turn 2" },
        ],
      },
      {
        providerFamily: "anthropic",
        cacheConfig: { enabled: true },
      },
    );

    const user2 = call.prompt[call.prompt.length - 1];
    expect(user2.role).toBe("user");
    const lastPart = (user2.content as Array<{ providerOptions?: unknown }>)[0];
    expect(lastPart.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("skipCacheWrite=true shifts the cache breakpoint back one turn so the fork doesn't write", () => {
    const call = translateRequest(
      {
        ...baseParams,
        skipCacheWrite: true,
        messages: [
          { role: "user", content: "turn 1" },
          { role: "assistant", content: "ok" } as ChatParams["messages"][number],
          { role: "user", content: "turn 2 (fork tail)" },
        ],
      },
      {
        providerFamily: "anthropic",
        cacheConfig: { enabled: true },
      },
    );

    const prompt = call.prompt;
    // messages.length === 3, skipCacheWrite === true -> breakpoint on index 1
    // which is the assistant "ok" turn.
    const assistant = prompt[prompt.length - 2];
    expect(assistant.role).toBe("assistant");
    const assistantLastBlock = (assistant.content as Array<{ providerOptions?: unknown }>).pop()!;
    expect(assistantLastBlock.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });

    // The new user tail must NOT carry a cache marker.
    const tail = prompt[prompt.length - 1];
    expect(tail.role).toBe("user");
    const tailPart = (tail.content as Array<{ providerOptions?: unknown }>).pop()!;
    expect(tailPart.providerOptions).toBeUndefined();
  });

  it("cache is a no-op when providerFamily !== 'anthropic'", () => {
    const call = translateRequest(
      {
        ...baseParams,
        messages: [{ role: "user", content: "turn 1" }],
      },
      {
        providerFamily: "openai",
        cacheConfig: { enabled: true },
      },
    );
    const user1 = call.prompt.find((m) => m.role === "user")!;
    const lastPart = (user1.content as Array<{ providerOptions?: unknown }>).pop()!;
    expect(lastPart.providerOptions).toBeUndefined();
  });
});

describe("translateRequest — tools", () => {
  const tool: ToolDefinition = {
    type: "function",
    function: {
      name: "Search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          // Schemaless property — exercises `fixTypelessProperties`.
          // The `type` field is required by the ToolDefinition type; we
          // cast through `unknown` so the test stays representative of
          // real-world Zod `.any()` output that ships without a type.
          filters: {} as unknown as { type: "string" },
        },
      },
    },
  };

  it("injects a permissive type union on properties without an explicit type", () => {
    const call = translateRequest(
      { ...baseParams, tools: [tool] },
      { providerFamily: "openai" },
    );
    expect(call.tools).toHaveLength(1);
    const schema = call.tools![0].inputSchema as {
      properties: { query: unknown; filters: { type: string[] } };
    };
    expect(schema.properties.filters.type).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "null",
    ]);
  });

  it("puts the Anthropic cache breakpoint on the LAST tool when cacheConfig enabled", () => {
    const tool2: ToolDefinition = {
      type: "function",
      function: {
        name: "OtherTool",
        description: "Other",
        parameters: { type: "object", properties: {} },
      },
    };
    const call = translateRequest(
      { ...baseParams, tools: [tool, tool2] },
      {
        providerFamily: "anthropic",
        cacheConfig: { enabled: true },
      },
    );
    expect(call.tools![0].providerOptions).toBeUndefined();
    expect(call.tools![1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});

describe("translateRequest — provider-specific option mapping", () => {
  it("openai + thinking enabled -> reasoningEffort: high", () => {
    const call = translateRequest(
      { ...baseParams, thinking: { type: "enabled", budgetTokens: 2048 } },
      { providerFamily: "openai" },
    );
    expect(call.providerOptions?.openai).toEqual({ reasoningEffort: "high" });
  });

  it("openai + thinking disabled -> reasoningEffort: minimal", () => {
    const call = translateRequest(
      { ...baseParams, thinking: { type: "disabled" } },
      { providerFamily: "openai" },
    );
    expect(call.providerOptions?.openai).toEqual({ reasoningEffort: "minimal" });
  });

  it("explicit reasoningEffort overrides thinking mapping for openai", () => {
    const call = translateRequest(
      {
        ...baseParams,
        thinking: { type: "enabled", budgetTokens: 2048 },
        reasoningEffort: "medium",
      },
      { providerFamily: "openai" },
    );
    expect(call.providerOptions?.openai).toEqual({ reasoningEffort: "medium" });
  });

  it("anthropic + thinking disabled does NOT set providerOptions", () => {
    const call = translateRequest(
      { ...baseParams, thinking: { type: "disabled" } },
      { providerFamily: "anthropic" },
    );
    expect(call.providerOptions?.anthropic).toBeUndefined();
  });

  it("google + thinking enabled -> thinkingConfig.thinkingBudget = budgetTokens", () => {
    const call = translateRequest(
      { ...baseParams, thinking: { type: "enabled", budgetTokens: 512 } },
      { providerFamily: "google" },
    );
    expect(call.providerOptions?.google).toEqual({
      thinkingConfig: { thinkingBudget: 512 },
    });
  });

  it("anthropic + thinking enabled drops temperature (API rejects it)", () => {
    const call = translateRequest(
      {
        ...baseParams,
        thinking: { type: "enabled", budgetTokens: 1024 },
        temperature: 0.7,
        max_tokens: 4096,
      },
      { providerFamily: "anthropic" },
    );
    expect(call.temperature).toBeUndefined();
  });

  it("anthropic without thinking preserves temperature", () => {
    const call = translateRequest(
      { ...baseParams, temperature: 0.7 },
      { providerFamily: "anthropic" },
    );
    expect(call.temperature).toBe(0.7);
  });
});

describe("translateRequest — JSON response formats", () => {
  it("json_schema -> responseFormat with schema + name", () => {
    const call = translateRequest(
      {
        ...baseParams,
        outputFormat: {
          type: "json_schema",
          name: "title_response",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
      { providerFamily: "openai" },
    );
    expect(call.responseFormat).toEqual({
      type: "json",
      name: "title_response",
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });
  });

  it("json_object -> responseFormat: { type: 'json' }", () => {
    const call = translateRequest(
      { ...baseParams, outputFormat: { type: "json_object" } },
      { providerFamily: "openai" },
    );
    expect(call.responseFormat).toEqual({ type: "json" });
  });
});
