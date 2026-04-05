import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
  textChunk,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { AIProvider, ChatStreamChunk, ChatCompletionUsage } from "../providers/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let config: ThreadConfig;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  config = {
    provider: provider,
    fs,
    computer,
    sessionDir: "/sessions",
    autoCompact: createAutoCompactConfig({ enabled: false }),
  };
});

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("Thread", () => {
  it("generates a sessionId", () => {
    const thread = new Thread(config);
    expect(thread.sessionId).toBeTruthy();
  });

  it("uses provided sessionId", () => {
    const thread = new Thread(config, { sessionId: "custom-id" });
    expect(thread.sessionId).toBe("custom-id");
  });

  describe("run() - text-only response", () => {
    it("yields text_delta and message_complete events", async () => {
      provider.addResponse(textResponse("Hello there!"));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("hi"));

      const textDeltas = events.filter((e) => e.type === "text_delta");
      expect(textDeltas.length).toBeGreaterThanOrEqual(1);

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
      if (complete?.type === "message_complete") {
        expect(complete.message.content).toBe("Hello there!");
      }
    });

    it("persists messages to session storage", async () => {
      provider.addResponse(textResponse("response"));

      const thread = new Thread(config, { sessionId: "s1" });
      await collectEvents(thread.run("hello"));

      // Session file should exist with user + assistant messages
      const exists = await fs.exists("/sessions/s1.jsonl");
      expect(exists).toBe(true);

      const content = fs.files.get("/sessions/s1.jsonl")!;
      expect(content).toContain('"user"');
      expect(content).toContain('"assistant"');
    });
  });

  describe("run() - tool call response", () => {
    it("executes tool and loops back to model", async () => {
      // Write a file for ReadFile to find
      fs.files.set("/test.txt", "file content");

      // First response: model calls ReadFile
      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/test.txt" }),
      );
      // Second response: model gives final text
      provider.addResponse(textResponse("I read the file."));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read test.txt"));

      const toolStart = events.find((e) => e.type === "tool_use_start");
      expect(toolStart).toBeDefined();
      if (toolStart?.type === "tool_use_start") {
        expect(toolStart.toolName).toBe("ReadFile");
      }

      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      if (toolResult?.type === "tool_result") {
        expect(toolResult.result.content).toContain("file content");
      }

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();

      // AI was called twice (tool call + final)
      expect(provider.calls).toHaveLength(2);
    });
  });

  describe("resume", () => {
    it("loads existing messages on first run", async () => {
      // Pre-populate session JSONL
      const entry = JSON.stringify({
        type: "message",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "previous message" },
      });
      fs.files.set("/sessions/s1.jsonl", entry + "\n");

      provider.addResponse(textResponse("continued"));

      const thread = new Thread(config, {
        sessionId: "s1",
        resume: true,
      });
      await collectEvents(thread.run("new message"));

      // Provider should have been called with messages including the previous one
      const sentMessages = provider.calls[0].messages;
      expect(sentMessages.length).toBeGreaterThanOrEqual(2);
      expect(sentMessages[0].content).toBe("previous message");
    });
  });

  describe("getMessages", () => {
    it("returns current message list after run", async () => {
      provider.addResponse(textResponse("reply"));

      const thread = new Thread(config, { sessionId: "s1" });
      await collectEvents(thread.run("hi"));

      const messages = await thread.getMessages();
      expect(messages).toHaveLength(2); // user + assistant
      expect(messages[0]).toEqual({ role: "user", content: "hi" });
      expect(messages[1].role).toBe("assistant");
    });

    it("loads from storage when not yet loaded", async () => {
      const entry = JSON.stringify({
        type: "message",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "stored" },
      });
      fs.files.set("/sessions/s1.jsonl", entry + "\n");

      const thread = new Thread(config, { sessionId: "s1" });
      const messages = await thread.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("stored");
    });
  });

  describe("compact()", () => {
    it("manually triggers compaction", async () => {
      provider.addResponse(textResponse("reply"));
      provider.addResponse(textResponse("Summary of conversation."));

      const thread = new Thread(config, { sessionId: "s1" });
      await collectEvents(thread.run("hi"));

      await thread.compact();

      const messages = await thread.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[Conversation Summary]");
    });
  });

  describe("auto-compact", () => {
    it("emits compact_start and compact_complete when threshold exceeded", async () => {
      const autoConfig = {
        ...config,
        autoCompact: createAutoCompactConfig({
          enabled: true,
          threshold: 1, // very low threshold to always trigger
        }),
      };

      // First call: normal response
      provider.addResponse(textResponse("reply"));
      // Second call: compaction summary
      provider.addResponse(textResponse("Summary."));

      const thread = new Thread(autoConfig, { sessionId: "s1" });
      const events = await collectEvents(thread.run("hi"));

      const compactStart = events.find((e) => e.type === "compact_start");
      const compactComplete = events.find(
        (e) => e.type === "compact_complete",
      );
      expect(compactStart).toBeDefined();
      expect(compactComplete).toBeDefined();
    });
  });

  describe("usage tracking", () => {
    const mockUsage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };

    it("yields usage event after a simple text response", async () => {
      provider.addResponse(textResponse("Hello!", mockUsage));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("hi"));

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(1);
      if (usageEvents[0].type === "usage") {
        expect(usageEvents[0].usage).toEqual(mockUsage);
        expect(usageEvents[0].model).toBeTruthy();
      }
    });

    it("yields turn_complete with accumulated usage after text response", async () => {
      provider.addResponse(textResponse("Hello!", mockUsage));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("hi"));

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
      if (turnComplete?.type === "turn_complete") {
        expect(turnComplete.usage).toMatchObject(mockUsage);
        expect(turnComplete.callCount).toBe(1);
      }
    });

    it("yields usage events for each model call in a tool loop", async () => {
      fs.files.set("/test.txt", "content");
      const usage1 = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
      const usage2 = { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 };

      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/test.txt" }, usage1),
      );
      provider.addResponse(textResponse("Done.", usage2));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read file"));

      const usageEvents = events.filter((e) => e.type === "usage");
      expect(usageEvents).toHaveLength(2);
      if (usageEvents[0].type === "usage") {
        expect(usageEvents[0].usage).toEqual(usage1);
      }
      if (usageEvents[1].type === "usage") {
        expect(usageEvents[1].usage).toEqual(usage2);
      }
    });

    it("accumulates usage across calls in turn_complete", async () => {
      fs.files.set("/test.txt", "content");
      const usage1 = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
      const usage2 = { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 };

      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/test.txt" }, usage1),
      );
      provider.addResponse(textResponse("Done.", usage2));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read file"));

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
      if (turnComplete?.type === "turn_complete") {
        expect(turnComplete.usage).toMatchObject({
          prompt_tokens: 130,
          completion_tokens: 35,
          total_tokens: 165,
        });
        expect(turnComplete.callCount).toBe(2);
      }
    });

    it("yields turn_complete with zero usage when provider returns no usage", async () => {
      provider.addResponse(textResponse("Hello!"));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("hi"));

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
      if (turnComplete?.type === "turn_complete") {
        expect(turnComplete.usage).toMatchObject({
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        });
        expect(turnComplete.callCount).toBe(1);
      }
    });
  });

  describe("abort", () => {
    it("stops the generator", async () => {
      // Use a response that yields many chunks
      const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
        id: `c${i}`,
        model: "m",
        choices: [
          {
            index: 0,
            delta: { content: `chunk${i} ` },
            finish_reason: null as string | null,
          },
        ],
      }));
      chunks.push({
        id: "final",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      provider.addResponse(chunks);

      const thread = new Thread(config, { sessionId: "s1" });
      const events: StreamEvent[] = [];
      const gen = thread.run("hi");

      // Collect a few events then abort
      for await (const event of gen) {
        events.push(event);
        if (events.length >= 3) {
          thread.abort();
          break;
        }
      }

      // Should have stopped early
      expect(events.length).toBeLessThan(100);
    });
  });

  describe("malformed tool calls", () => {
    it("handles all-malformed tool calls by emitting error results and continuing", async () => {
      // First response: model emits a tool call with invalid JSON args
      const malformedChunks: ChatStreamChunk[] = [
        {
          id: "m1",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc_bad",
                type: "function",
                function: { name: "ReadFile", arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m2",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "{not valid json" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m3",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];
      provider.addResponse(malformedChunks);
      // Second call: model gives a final text response
      provider.addResponse(textResponse("recovered"));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("test"));

      const toolResult = events.find(
        (e) => e.type === "tool_result" && e.toolUseId === "tc_bad",
      );
      expect(toolResult).toBeDefined();
      if (toolResult?.type === "tool_result") {
        expect(toolResult.result.isError).toBe(true);
      }

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
      // Provider was called twice: once for malformed, once for recovery
      expect(provider.calls).toHaveLength(2);
    });

    it("handles mixed valid and malformed tool calls", async () => {
      fs.files.set("/test.txt", "hello");

      // Two tool calls: one valid, one with bad JSON
      const mixedChunks: ChatStreamChunk[] = [
        {
          id: "m1",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "tc_good",
                type: "function",
                function: { name: "ReadFile", arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m2",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: JSON.stringify({ file_path: "/test.txt" }) },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m3",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 1,
                id: "tc_bad",
                type: "function",
                function: { name: "WriteFile", arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m4",
          model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 1,
                function: { arguments: "not json at all" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m5",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];
      provider.addResponse(mixedChunks);
      provider.addResponse(textResponse("done"));

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("test"));

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults.length).toBeGreaterThanOrEqual(2);

      const goodResult = toolResults.find(
        (e) => e.type === "tool_result" && e.toolName === "ReadFile",
      );
      expect(goodResult).toBeDefined();
      if (goodResult?.type === "tool_result") {
        expect(goodResult.result.isError).toBeFalsy();
      }

      const badResult = toolResults.find(
        (e) => e.type === "tool_result" && e.toolName === "WriteFile",
      );
      expect(badResult).toBeDefined();
      if (badResult?.type === "tool_result") {
        expect(badResult.result.isError).toBe(true);
      }
    });
  });

  describe("preventContinuation emits turn_complete", () => {
    it("yields turn_complete when hook sets preventContinuation", async () => {
      fs.files.set("/test.txt", "content");

      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/test.txt" }),
      );

      const hookConfig: ThreadConfig = {
        ...config,
        hooks: [
          {
            event: "PostToolUse",
            handler: () => ({ preventContinuation: true }),
          },
        ],
      };

      const thread = new Thread(hookConfig, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read file"));

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
      if (turnComplete?.type === "turn_complete") {
        expect(turnComplete.callCount).toBe(1);
      }
    });
  });

  describe("max_turns", () => {
    it("emits turn_complete before max_turns_reached", async () => {
      fs.files.set("/test.txt", "content");

      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/test.txt" }),
      );
      provider.addResponse(
        toolCallResponse("tc_2", "ReadFile", { file_path: "/test.txt" }),
      );

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read file", { maxTurns: 1 }));

      const turnCompleteIdx = events.findIndex((e) => e.type === "turn_complete");
      const maxTurnsIdx = events.findIndex((e) => e.type === "max_turns_reached");

      expect(turnCompleteIdx).not.toBe(-1);
      expect(maxTurnsIdx).not.toBe(-1);
      expect(turnCompleteIdx).toBeLessThan(maxTurnsIdx);
    });
  });

  describe("truncated response", () => {
    it("appends truncation notice on finish_reason length", async () => {
      const truncatedChunks: ChatStreamChunk[] = [
        {
          id: "t1",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "partial output" }, finish_reason: null }],
        },
        {
          id: "t2",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];
      provider.addResponse(truncatedChunks);

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("generate long text"));

      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(textDeltas).toContain("[Response truncated");
    });
  });

  describe("all-malformed with maxTurns", () => {
    it("emits turn_complete and max_turns_reached when all tool calls are malformed at limit", async () => {
      const malformedChunks: ChatStreamChunk[] = [
        {
          id: "m1", model: "mock-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "tc_x", type: "function", function: { name: "ReadFile", arguments: "" } }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "m2", model: "mock-model",
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "{{bad" } }] },
            finish_reason: null,
          }],
        },
        {
          id: "m3", model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];
      provider.addResponse(malformedChunks);

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("test", { maxTurns: 1 }));

      const turnComplete = events.find((e) => e.type === "turn_complete");
      const maxTurns = events.find((e) => e.type === "max_turns_reached");
      expect(turnComplete).toBeDefined();
      expect(maxTurns).toBeDefined();
    });
  });

  describe("tool result budget snapshot", () => {
    it("does not mutate canonical messages when budget is applied", async () => {
      // Build a thread with pre-seeded long tool results and budget enabled
      const longContent = "x".repeat(10000);
      const entry1 = JSON.stringify({
        type: "message", uuid: "u1", parentUuid: null, sessionId: "s1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hi" },
      });
      const entry2 = JSON.stringify({
        type: "message", uuid: "u2", parentUuid: "u1", sessionId: "s1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/f"}' } }],
        },
      });
      const entry3 = JSON.stringify({
        type: "message", uuid: "u3", parentUuid: "u2", sessionId: "s1",
        timestamp: new Date().toISOString(),
        message: { role: "tool", tool_call_id: "tc_1", content: longContent },
      });
      fs.files.set("/sessions/s1.jsonl", [entry1, entry2, entry3].join("\n") + "\n");

      provider.addResponse(textResponse("ok"));

      const budgetConfig: ThreadConfig = {
        ...config,
        toolResultBudget: { enabled: true, maxCharsPerResult: 100, maxTotalChars: 500 },
      };

      const thread = new Thread(budgetConfig, { sessionId: "s1", resume: true });
      await collectEvents(thread.run("continue"));

      // The canonical messages should still have the original long content
      const messages = await thread.getMessages();
      const toolMsg = messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      // The original long content should be preserved in canonical messages
      // (budget only applies to the API snapshot)
      if (toolMsg && typeof toolMsg.content === "string") {
        expect(toolMsg.content.length).toBeGreaterThan(100);
      }
    });
  });

  describe("content_filter finish reason", () => {
    it("yields text_delta with content filter message", async () => {
      const contentFilterChunk: ChatStreamChunk = {
        id: "cf-1",
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };

      provider.addResponse([textChunk("partial"), contentFilterChunk]);

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("generate something inappropriate"));

      const textDeltas = events.filter(
        (e) => e.type === "text_delta" && (e as any).text.includes("[Response blocked by content filter]"),
      );
      expect(textDeltas).toHaveLength(1);
    });
  });

  describe("auto_compact_failed event type", () => {
    it("auto_compact_failed is a valid StreamEvent type distinct from error", () => {
      const event: StreamEvent = { type: "auto_compact_failed", error: new Error("test") };
      expect(event.type).toBe("auto_compact_failed");
      expect(event.type).not.toBe("error");
    });
  });

  describe("outer catch generates synthetic tool results", () => {
    it("synthesizes missing tool results on unexpected error", async () => {
      // Create a provider that errors after yielding a tool call
      let callCount = 0;
      const errorProvider: AIProvider = {
        async *chat(_params) {
          callCount++;
          if (callCount === 1) {
            // Yield a tool call response
            for (const chunk of toolCallResponse("tc_err", "ReadFile", { file_path: "/x" })) {
              yield chunk;
            }
          } else {
            throw new Error("Unexpected provider error");
          }
        },
      };

      const threadConfig: ThreadConfig = {
        ...config,
        provider: errorProvider,
        tools: [
          {
            name: "ReadFile",
            description: "Read a file",
            parameters: { type: "object", properties: { file_path: { type: "string" } } },
            async call() {
              throw new Error("Unexpected tool error causing outer catch");
            },
          },
        ],
      };

      const thread = new Thread(threadConfig, { sessionId: "s1" });
      const events = await collectEvents(thread.run("read file"));

      // After the error, messages should still be valid
      const messages = await thread.getMessages();
      const assistantWithToolCalls = messages.find(
        (m) => m.role === "assistant" && (m as any).tool_calls?.length > 0,
      );

      if (assistantWithToolCalls) {
        const toolCallIds = new Set(
          ((assistantWithToolCalls as any).tool_calls || []).map((tc: any) => tc.id),
        );
        const toolResults = messages.filter(
          (m) => m.role === "tool" && toolCallIds.has((m as any).tool_call_id),
        );
        // Every tool_call should have a corresponding tool result
        expect(toolResults.length).toBe(toolCallIds.size);
      }
    });
  });
});
