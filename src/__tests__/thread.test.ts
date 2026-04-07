import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
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

      // Provider should have been called with messages including the previous one.
      // normalizeMessagesForAPI merges consecutive user messages, so both the
      // resumed message and the new prompt may be in a single merged user entry.
      const sentMessages = provider.calls[0].messages;
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      const firstContent = sentMessages[0].content;
      if (typeof firstContent === "string") {
        expect(firstContent).toContain("previous message");
      } else {
        const texts = (firstContent as { type: string; text: string }[])
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { text: string }) => p.text);
        expect(texts.some((t: string) => t.includes("previous message"))).toBe(true);
      }
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

    it("retries compaction via circuit breaker instead of calling provider with oversized context", async () => {
      // Use a long prompt so token estimate exceeds threshold before compact,
      // but falls below it after a short summary replaces the history.
      const longPrompt = "x".repeat(800); // ~200 tokens
      let compactCallIdx = 0;
      const callContexts: string[] = [];
      const compactProvider: AIProvider = {
        async *chat(params: ChatParams) {
          const isCompactCall = params.system?.includes("summariz");
          callContexts.push(isCompactCall ? "compact" : "regular");
          if (isCompactCall) {
            compactCallIdx++;
            if (compactCallIdx === 1) {
              throw new Error("Simulated compact failure");
            }
            // Short summary so post-compact token count drops below threshold
            for (const chunk of textResponse("ok")) yield chunk;
            return;
          }
          for (const chunk of textResponse("Final reply.")) yield chunk;
        },
      };

      const autoConfig: ThreadConfig = {
        ...config,
        provider: compactProvider,
        autoCompact: createAutoCompactConfig({
          enabled: true,
          threshold: 100, // 800 chars / 4 ≈ 200 tokens > 100; post-compact ≈ 10 < 100
        }),
      };

      const thread = new Thread(autoConfig, { sessionId: "compact-retry" });
      const events = await collectEvents(thread.run(longPrompt));

      const compactStarts = events.filter((e) => e.type === "compact_start");
      const compactFailed = events.filter((e) => e.type === "auto_compact_failed");
      const compactComplete = events.filter((e) => e.type === "compact_complete");

      // First compact attempt failed, retried, succeeded
      expect(compactFailed).toHaveLength(1);
      expect(compactComplete.length).toBeGreaterThanOrEqual(1);
      expect(compactStarts.length).toBeGreaterThanOrEqual(2);

      // Both initial provider calls must be compact calls — the failed compact
      // must NOT have fallen through to a regular API call with oversized context
      expect(callContexts[0]).toBe("compact");
      expect(callContexts[1]).toBe("compact");

      // Eventually a regular response is produced
      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
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
        toolResultBudget: { enabled: true, maxCharsPerResult: 100, maxCharsPerGroup: 500 },
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

// ---------------------------------------------------------------------------
// Malformed JSON tool calls hard cap
// ---------------------------------------------------------------------------
describe("malformed tool call hard cap", () => {
  it("breaks out of the loop after 5 consecutive all-malformed iterations", async () => {
    for (let i = 0; i < 7; i++) {
      const malformedChunks: ChatStreamChunk[] = [
        {
          id: `m${i}-1`, model: "m",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: `tc_${i}`, type: "function", function: { name: "Bash", arguments: "" } }],
            },
            finish_reason: null,
          }],
        },
        {
          id: `m${i}-2`, model: "m",
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "{{not json" } }] },
            finish_reason: null,
          }],
        },
        {
          id: `m${i}-3`, model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ];
      provider.addResponse(malformedChunks);
    }

    const thread = new Thread(config, { sessionId: "malformed-cap" });
    const events = await collectEvents(thread.run("test"));

    const errorEvent = events.find(
      (e) => e.type === "error" && (e as any).error?.message?.includes("malformed"),
    );
    expect(errorEvent).toBeDefined();
    expect(provider.calls.length).toBeLessThanOrEqual(7);
  });
});

