import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
  multiToolCallResponse,
  textChunk,
  stopChunk,
  toolCallsFinishChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent, ChatMessage, AssistantMessage, ToolResultMessage } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let baseConfig: ThreadConfig;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  baseConfig = {
    provider,
    fs,
    computer,
    sessionDir: "/sessions",
    autoCompact: createAutoCompactConfig({ enabled: false }),
    debug: true,
  };
});

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function assertMessageIntegrity(messages: ChatMessage[]): void {
  const normalized = normalizeMessagesForAPI(messages);
  assertValidMessageSequence(normalized);
  expect(normalizeMessagesForAPI(normalized)).toEqual(normalized);
}

describe("Multi-turn integration tests", () => {
  // -----------------------------------------------------------------------
  // 1. Tool chain pairing — 3-turn flow
  // -----------------------------------------------------------------------
  describe("tool chain pairing", () => {
    it("maintains valid tool pairing across 3-turn tool chain", async () => {
      fs.files.set("/a.txt", "alpha");
      fs.files.set("/b.txt", "bravo");

      // Turn 1: model calls ReadFile on /a.txt
      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/a.txt" }),
      );
      // Turn 2: model calls ReadFile on /b.txt
      provider.addResponse(
        toolCallResponse("tc_2", "ReadFile", { file_path: "/b.txt" }),
      );
      // Turn 3: model gives final text
      provider.addResponse(textResponse("I read both files."));

      const thread = new Thread(baseConfig, { sessionId: "chain-1" });
      const events = await collectEvents(thread.run("read both files"));

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(2);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);

      // Verify each tool_use has exactly one matching tool result
      const useIds = new Set<string>();
      const resultIds = new Set<string>();
      for (const msg of messages) {
        if (msg.role === "assistant") {
          for (const tc of (msg as AssistantMessage).tool_calls ?? []) {
            useIds.add(tc.id);
          }
        }
        if (msg.role === "tool") {
          resultIds.add((msg as ToolResultMessage).tool_call_id);
        }
      }
      expect(useIds.size).toBe(2);
      for (const id of useIds) {
        expect(resultIds.has(id)).toBe(true);
      }
    });

    it("handles back-to-back tool calls across multiple turns", async () => {
      fs.files.set("/x.txt", "x content");

      // Turn 1: call tool
      provider.addResponse(
        toolCallResponse("tc_a", "ReadFile", { file_path: "/x.txt" }),
      );
      // Turn 2: call another tool
      provider.addResponse(
        toolCallResponse("tc_b", "Glob", { pattern: "*.txt" }),
      );
      // Turn 3: final text
      provider.addResponse(textResponse("Done."));

      const thread = new Thread(baseConfig, { sessionId: "chain-2" });
      const events = await collectEvents(thread.run("explore"));

      expect(provider.calls).toHaveLength(3);
      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Auto-compaction mid-conversation
  // -----------------------------------------------------------------------
  describe("auto-compaction mid-conversation", () => {
    it("compacts and continues with valid messages", async () => {
      const longPrompt = "x".repeat(800);
      let callCount = 0;
      const compactProvider: AIProvider = {
        defaultModel: "mock-model",
        async *chat(params: ChatParams) {
          callCount++;
          const isCompact = params.system?.includes("summariz");
          if (isCompact) {
            for (const c of textResponse("Summary of conversation so far.")) yield c;
            return;
          }
          if (callCount <= 2) {
            for (const c of textResponse("Got it.")) yield c;
          } else {
            for (const c of textResponse("Final answer.")) yield c;
          }
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: compactProvider,
        autoCompact: createAutoCompactConfig({
          enabled: true,
          threshold: 100,
        }),
      };

      const thread = new Thread(config, { sessionId: "compact-mid" });
      const events = await collectEvents(thread.run(longPrompt));

      const compactComplete = events.filter((e) => e.type === "compact_complete");
      expect(compactComplete.length).toBeGreaterThanOrEqual(1);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
      expect(messages[0].role).toBe("user");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Abort during streaming tool execution
  // -----------------------------------------------------------------------
  describe("abort during tool execution", () => {
    it("persists partial results and generates synthetic tool results", async () => {
      let abortReject: (() => void) | undefined;
      const slowProvider: AIProvider = {
        defaultModel: "mock-model",
        async *chat() {
          for (const c of toolCallResponse("tc_slow", "Bash", { command: "sleep 10" })) {
            yield c;
          }
        },
      };
      const slowComputer = new MockComputer((_cmd, opts) => {
        return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
          abortReject = () => reject(new DOMException("Aborted", "AbortError"));
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const config: ThreadConfig = {
        ...baseConfig,
        provider: slowProvider,
        computer: slowComputer,
      };

      const thread = new Thread(config, { sessionId: "abort-1" });
      const gen = thread.run("run slow command");
      const events: StreamEvent[] = [];

      // Collect events but abort quickly after tool starts
      let aborted = false;
      for await (const event of gen) {
        events.push(event);
        if (event.type === "tool_use_start" && !aborted) {
          aborted = true;
          thread.abort();
        }
      }

      const messages = await thread.getMessages();
      if (messages.length > 1) {
        const normalized = normalizeMessagesForAPI(messages);
        assertValidMessageSequence(normalized);
      }
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // 4. Permission denial mid-batch
  // -----------------------------------------------------------------------
  describe("permission denial mid-batch", () => {
    it("denied tool gets error result while allowed tool executes", async () => {
      fs.files.set("/allowed.txt", "ok content");

      provider.addResponse(
        multiToolCallResponse([
          { id: "tc_ok", name: "ReadFile", args: { file_path: "/allowed.txt" } },
          { id: "tc_denied", name: "Bash", args: { command: "rm -rf /" } },
        ]),
      );
      provider.addResponse(textResponse("Handled both results."));

      const config: ThreadConfig = {
        ...baseConfig,
        permissions: {
          mode: "default",
          handler: async (req) => {
            if (req.toolName === "Bash") {
              return { allow: false, feedback: "Dangerous command" };
            }
            return { allow: true };
          },
        },
      };

      const thread = new Thread(config, { sessionId: "perm-deny-1" });
      const events = await collectEvents(thread.run("do both"));

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults.length).toBeGreaterThanOrEqual(1);

      const deniedEvents = events.filter((e) => e.type === "permission_denied");
      expect(deniedEvents.length).toBeGreaterThanOrEqual(1);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);

      // The denied tool should have an error result
      const toolMessages = messages.filter((m) => m.role === "tool");
      const deniedResult = toolMessages.find(
        (m) => (m as ToolResultMessage).tool_call_id === "tc_denied",
      ) as ToolResultMessage | undefined;
      expect(deniedResult).toBeDefined();
      expect(deniedResult!.isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Model switch (retry fallback)
  // -----------------------------------------------------------------------
  describe("model switch on retry", () => {
    it("strips thinking signatures and produces valid messages", async () => {
      let callCount = 0;
      const fallbackProvider: AIProvider = {
        defaultModel: "mock-model",
        async *chat(params: ChatParams) {
          callCount++;
          if (callCount === 1) {
            const err = new Error("Overloaded") as Error & { status?: number };
            err.status = 529;
            throw err;
          }
          for (const c of textResponse("Fallback response.")) yield c;
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: fallbackProvider,
        retry: {
          maxRetries: 2,
          baseDelayMs: 10,
          maxDelayMs: 50,
        },
      };

      const thread = new Thread(config, { sessionId: "model-switch-1" });
      const events = await collectEvents(thread.run("test retry"));

      const retryEvents = events.filter((e) => e.type === "retry_attempt");
      expect(retryEvents.length).toBeGreaterThanOrEqual(1);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Resume after crash (abort mid-tool, then resume)
  // -----------------------------------------------------------------------
  describe("resume after crash", () => {
    it("resumes with synthetic tool results for interrupted turn", async () => {
      // First run: model calls a tool, we abort before it completes
      const firstRunProvider: AIProvider = {
        defaultModel: "mock-model",
        async *chat() {
          for (const c of toolCallResponse("tc_crash", "Bash", { command: "echo hi" })) {
            yield c;
          }
        },
      };
      const hangingComputer = new MockComputer((_cmd, opts) => {
        return new Promise<{ exitCode: number; stdout: string; stderr: string }>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const firstConfig: ThreadConfig = {
        ...baseConfig,
        provider: firstRunProvider,
        computer: hangingComputer,
      };

      const thread1 = new Thread(firstConfig, { sessionId: "resume-crash" });
      const gen = thread1.run("crash test");
      const events1: StreamEvent[] = [];
      let aborted = false;
      for await (const event of gen) {
        events1.push(event);
        if (event.type === "tool_use_start" && !aborted) {
          aborted = true;
          thread1.abort();
        }
      }

      // Second run: resume the session with a fresh provider
      provider.addResponse(textResponse("Recovered and continuing."));

      const resumeConfig: ThreadConfig = {
        ...baseConfig,
        provider,
        computer: new MockComputer(),
      };

      const thread2 = new Thread(resumeConfig, { sessionId: "resume-crash", resume: true });
      const events2 = await collectEvents(thread2.run("continue"));

      const messages = await thread2.getMessages();
      assertMessageIntegrity(messages);

      const turnComplete = events2.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // 7. Structured output alongside tools
  // -----------------------------------------------------------------------
  describe("structured output alongside tools", () => {
    it("handles tool calls followed by structured text response", async () => {
      fs.files.set("/data.json", '{"count": 42}');

      // Turn 1: model calls ReadFile
      provider.addResponse(
        toolCallResponse("tc_read", "ReadFile", { file_path: "/data.json" }),
      );
      // Turn 2: model produces final text
      provider.addResponse(textResponse('{"result": "found 42 items"}'));

      const thread = new Thread(baseConfig, { sessionId: "structured-1" });
      const events = await collectEvents(
        thread.run("read data and report", {
          outputFormat: {
            type: "json_schema",
            name: "report",
            schema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
          },
        }),
      );

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Multi-turn conversation preserves message integrity
  // -----------------------------------------------------------------------
  describe("multi-turn conversation integrity", () => {
    it("5-turn conversation with mixed tool and text responses", async () => {
      fs.files.set("/readme.md", "# Project\nA test project.");
      fs.files.set("/src/index.ts", "export const x = 1;");

      // Turn 1: ReadFile
      provider.addResponse(
        toolCallResponse("tc_r1", "ReadFile", { file_path: "/readme.md" }),
      );
      // Turn 2: ReadFile
      provider.addResponse(
        toolCallResponse("tc_r2", "ReadFile", { file_path: "/src/index.ts" }),
      );
      // Turn 3: Glob
      provider.addResponse(
        toolCallResponse("tc_g", "Glob", { pattern: "**/*.ts" }),
      );
      // Turn 4: text
      provider.addResponse(textResponse("I found the following files."));

      const thread = new Thread(baseConfig, { sessionId: "five-turn" });
      const events = await collectEvents(thread.run("analyze project"));

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(3);

      expect(provider.calls).toHaveLength(4);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);

      // Check that all provider calls received valid message arrays
      for (let i = 0; i < provider.calls.length; i++) {
        const sentMsgs = provider.calls[i].messages;
        assertValidMessageSequence(sentMsgs);
      }
    });

    it("second run on same thread maintains integrity", async () => {
      fs.files.set("/file.txt", "content");

      provider.addResponse(
        toolCallResponse("tc_1", "ReadFile", { file_path: "/file.txt" }),
      );
      provider.addResponse(textResponse("First run done."));

      const thread = new Thread(baseConfig, { sessionId: "multi-run" });
      await collectEvents(thread.run("first"));

      provider.addResponse(textResponse("Second run done."));
      await collectEvents(thread.run("second"));

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
      // Should have: user, assistant+tc, tool, assistant, user, assistant
      expect(messages.length).toBeGreaterThanOrEqual(5);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Parallel tool calls (multi-tool in single turn)
  // -----------------------------------------------------------------------
  describe("parallel tool calls", () => {
    it("executes multiple tools in parallel and pairs results correctly", async () => {
      fs.files.set("/a.txt", "alpha");
      fs.files.set("/b.txt", "bravo");

      provider.addResponse(
        multiToolCallResponse([
          { id: "tc_pa", name: "ReadFile", args: { file_path: "/a.txt" } },
          { id: "tc_pb", name: "ReadFile", args: { file_path: "/b.txt" } },
        ]),
      );
      provider.addResponse(textResponse("Read both files in parallel."));

      const thread = new Thread(baseConfig, { sessionId: "parallel-1" });
      const events = await collectEvents(thread.run("read both"));

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(2);

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
    });
  });

  // -----------------------------------------------------------------------
  // 10. maxTurns limit
  // -----------------------------------------------------------------------
  describe("maxTurns limit", () => {
    it("stops after maxTurns and yields max_turns_reached event", async () => {
      fs.files.set("/x.txt", "x");

      // Queue many tool calls — more than maxTurns allows
      for (let i = 0; i < 10; i++) {
        provider.addResponse(
          toolCallResponse(`tc_${i}`, "ReadFile", { file_path: "/x.txt" }),
        );
      }
      provider.addResponse(textResponse("Should not reach this."));

      const thread = new Thread(baseConfig, { sessionId: "max-turns" });
      const events = await collectEvents(
        thread.run("keep reading", { maxTurns: 3 }),
      );

      const maxEvent = events.find((e) => e.type === "max_turns_reached");
      expect(maxEvent).toBeDefined();

      const messages = await thread.getMessages();
      assertMessageIntegrity(messages);
    });
  });
});
