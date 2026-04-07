import { describe, it, expect, vi, beforeEach } from "vitest";
import { postToolStep, type PostToolStepParams } from "../pipeline/post-tool-step.js";
import { MockFs } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import type { ChatMessage, ToolCallContent, StreamEvent } from "../session/types.js";
import type { ChatCompletionUsage, OutputFormat, ToolDefinition } from "../providers/types.js";

function makeTurnUsage(total = 100): ChatCompletionUsage {
  return {
    prompt_tokens: total / 2,
    completion_tokens: total / 2,
    total_tokens: total,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
  };
}

function makeToolCall(name: string, args: string, id = "tc1"): ToolCallContent {
  return { id, type: "function", function: { name, arguments: args } };
}

function makeBaseParams(overrides?: Partial<PostToolStepParams>): PostToolStepParams {
  const fs = new MockFs();
  const storage = new SessionStorage(fs, "/sessions");
  return {
    touchedFilePaths: [],
    toolCalls: [makeToolCall("ReadFile", '{"path":"/a.txt"}')],
    spilledRecords: [],
    signal: new AbortController().signal,
    sessionId: "test-session",
    storage,
    messages: [{ role: "user", content: "Hi" }],
    hooks: [],
    allSkills: [],
    activatedSkills: new Set(),
    projectContext: undefined,
    activatedContextRules: new Set(),
    cwd: "/test",
    isFinalResponseMode: false,
    outputFormat: undefined,
    maxTurns: undefined,
    callCount: 1,
    preventContinuation: false,
    turnUsage: makeTurnUsage(),
    model: "test-model",
    toolSearchEnabled: false,
    getActiveToolDefinitions: () => [],
    buildSystemPrompt: vi.fn().mockResolvedValue("system prompt"),
    ...overrides,
  };
}

describe("postToolStep", () => {
  it("signals continue when no limits reached", async () => {
    const result = await postToolStep(makeBaseParams());

    expect(result.shouldContinue).toBe(true);
    expect(result.shouldBreak).toBe(false);
    expect(result.hasAttemptedReactiveCompactReset).toBe(true);
  });

  it("signals break when preventContinuation is true", async () => {
    const result = await postToolStep(makeBaseParams({ preventContinuation: true }));

    expect(result.shouldBreak).toBe(true);
    expect(result.shouldContinue).toBe(false);
    expect(result.preventContinuation).toBe(true);

    const turnComplete = result.events.filter((e) => e.type === "turn_complete");
    expect(turnComplete).toHaveLength(1);
  });

  it("signals break when maxTurns reached", async () => {
    const result = await postToolStep(makeBaseParams({
      maxTurns: 3,
      callCount: 3,
    }));

    expect(result.shouldBreak).toBe(true);
    expect(result.shouldContinue).toBe(false);

    const maxTurnsReached = result.events.filter((e) => e.type === "max_turns_reached");
    expect(maxTurnsReached).toHaveLength(1);
    const turnComplete = result.events.filter((e) => e.type === "turn_complete");
    expect(turnComplete).toHaveLength(1);
  });

  it("does not break when callCount < maxTurns", async () => {
    const result = await postToolStep(makeBaseParams({
      maxTurns: 5,
      callCount: 3,
    }));

    expect(result.shouldBreak).toBe(false);
    expect(result.shouldContinue).toBe(true);
  });

  it("breaks on abort and appends interruption message", async () => {
    const ac = new AbortController();
    ac.abort();
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];

    const result = await postToolStep(makeBaseParams({
      signal: ac.signal,
      messages,
    }));

    expect(result.shouldBreak).toBe(true);
    expect(messages[messages.length - 1].content).toContain("interrupted");
  });

  it("persists spilled records", async () => {
    const fs = new MockFs();
    const storage = new SessionStorage(fs, "/sessions");
    const appendSpy = vi.spyOn(storage, "appendContentReplacement").mockResolvedValue();

    const record = { toolUseId: "t1", replacement: "[spilled]" };
    await postToolStep(makeBaseParams({
      storage,
      spilledRecords: [record],
    }));

    expect(appendSpy).toHaveBeenCalledWith("test-session", [record]);
  });

  it("rebuilds system prompt when skills are activated by touched files", async () => {
    const buildPrompt = vi.fn().mockResolvedValue("new system prompt");

    const result = await postToolStep(makeBaseParams({
      touchedFilePaths: ["/test/src/index.ts"],
      allSkills: [{
        name: "test-skill",
        path: "/test/src/index.ts",
        description: "Test skill",
        globs: ["**/*.ts"],
        content: "skill content",
      }],
      activatedSkills: new Set<string>(),
      buildSystemPrompt: buildPrompt,
    }));

    expect(buildPrompt).toHaveBeenCalled();
    expect(result.systemPrompt).toBe("new system prompt");
  });

  it("refreshes tool definitions when toolSearchEnabled", async () => {
    const toolDefs: ToolDefinition[] = [{
      type: "function",
      function: { name: "TestTool", description: "a tool", parameters: { type: "object", properties: {} } },
    }];
    const getActive = vi.fn().mockReturnValue(toolDefs);

    const result = await postToolStep(makeBaseParams({
      toolSearchEnabled: true,
      getActiveToolDefinitions: getActive,
    }));

    expect(getActive).toHaveBeenCalled();
    expect(result.toolDefs).toEqual(toolDefs);
  });

  it("detects StructuredOutput tool call in final_response mode", async () => {
    const outputFormat: OutputFormat = {
      type: "json_schema",
      schema: { type: "object" },
      name: "Test",
    };

    const result = await postToolStep(makeBaseParams({
      isFinalResponseMode: true,
      outputFormat,
      toolCalls: [makeToolCall("StructuredOutput", '{"data":{"answer":42}}')],
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(1);
    expect((soEvents[0] as { data: unknown }).data).toEqual({ answer: 42 });
    expect(result.preventContinuation).toBe(true);
    expect(result.shouldBreak).toBe(true);
  });

  it("emits structured_output with raw args when JSON parse fails", async () => {
    const outputFormat: OutputFormat = {
      type: "json_schema",
      schema: { type: "object" },
      name: "Test",
    };

    const result = await postToolStep(makeBaseParams({
      isFinalResponseMode: true,
      outputFormat,
      toolCalls: [makeToolCall("StructuredOutput", "not json")],
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(1);
    expect((soEvents[0] as { data: unknown }).data).toBe("not json");
    expect(result.preventContinuation).toBe(true);
  });

  it("does not detect StructuredOutput when not in final_response mode", async () => {
    const result = await postToolStep(makeBaseParams({
      isFinalResponseMode: false,
      toolCalls: [makeToolCall("StructuredOutput", '{"data":{"answer":42}}')],
    }));

    const soEvents = result.events.filter((e) => e.type === "structured_output");
    expect(soEvents).toHaveLength(0);
    expect(result.preventContinuation).toBe(false);
  });
});
