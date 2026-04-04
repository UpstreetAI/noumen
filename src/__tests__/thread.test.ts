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
import type { ChatStreamChunk } from "../providers/types.js";
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
    aiProvider: provider,
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
});
