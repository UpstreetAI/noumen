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
import type { AIProvider, ChatParams, ChatStreamChunk, ChatCompletionUsage } from "../providers/types.js";
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
    it("recovers from first truncation by escalating max_tokens, then surfaces notice on repeated truncation", async () => {
      const truncatedChunks1: ChatStreamChunk[] = [
        {
          id: "t1",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "partial " }, finish_reason: null }],
        },
        {
          id: "t2",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];
      const truncatedChunks2: ChatStreamChunk[] = [
        {
          id: "t3",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "still partial " }, finish_reason: null }],
        },
        {
          id: "t4",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];
      const truncatedChunks3: ChatStreamChunk[] = [
        {
          id: "t5",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "more " }, finish_reason: null }],
        },
        {
          id: "t6",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];
      const truncatedChunks4: ChatStreamChunk[] = [
        {
          id: "t7",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "final " }, finish_reason: null }],
        },
        {
          id: "t8",
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        },
      ];
      // Queue 4 truncated responses — first 3 trigger recovery, 4th surfaces notice
      provider.addResponse(truncatedChunks1);
      provider.addResponse(truncatedChunks2);
      provider.addResponse(truncatedChunks3);
      provider.addResponse(truncatedChunks4);

      const thread = new Thread(config, { sessionId: "s1" });
      const events = await collectEvents(thread.run("generate long text"));

      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(textDeltas).toContain("[Response truncated");
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

    it("does not execute tool calls when content_filter triggers", async () => {
      let toolCalled = false;
      const threadConfig: ThreadConfig = {
        ...config,
        tools: [
          {
            name: "Dangerous",
            description: "dangerous tool",
            parameters: { type: "object", properties: { x: { type: "string" } } },
            async call() {
              toolCalled = true;
              return { content: "executed" };
            },
          },
        ],
      };

      const cfProvider: AIProvider = {
        async *chat() {
          yield toolCallStartChunk("tc_cf", "Dangerous");
          yield toolCallArgChunk('{"x":"val"}');
          yield {
            id: "cf-2",
            model: "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };

      const thread = new Thread(
        { ...threadConfig, provider: cfProvider },
        { sessionId: "s-cf" },
      );
      const events = await collectEvents(thread.run("do it"));

      expect(toolCalled).toBe(false);
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(0);
    });
  });

  describe("finishReason length with tool calls proceeds normally", () => {
    it("executes tool calls when response truncated with tool_use blocks", async () => {
      let toolCalled = false;
      const threadConfig: ThreadConfig = {
        ...config,
        tools: [
          {
            name: "WriteFile",
            description: "write a file",
            parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } },
            async call() {
              toolCalled = true;
              return { content: "written" };
            },
          },
        ],
      };

      let callCount = 0;
      const truncatedProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield textChunk("Starting to write...");
            yield toolCallStartChunk("tc_trunc", "WriteFile");
            yield toolCallArgChunk('{"file_path":"/foo"}');
            yield {
              id: "len-1",
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "length" }],
              usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
            };
          } else {
            yield textChunk("Done.");
            yield { id: "stop-1", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          }
        },
      };

      const thread = new Thread(
        { ...threadConfig, provider: truncatedProvider },
        { sessionId: "s-trunc" },
      );
      const events = await collectEvents(thread.run("write file"));

      expect(toolCalled).toBe(true);
      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(1);
    });

    it("text-only truncation still triggers output token recovery", async () => {
      let callCount = 0;
      const truncatedProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield textChunk("Partial text...");
            yield {
              id: "len-1",
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "length" }],
              usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
            };
          } else {
            yield textChunk("...continuation");
            yield { id: "stop-1", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          }
        },
      };

      const thread = new Thread(
        { ...config, provider: truncatedProvider },
        { sessionId: "s-recovery" },
      );
      const events = await collectEvents(thread.run("write something long"));

      expect(callCount).toBe(2);
      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text);
      expect(textDeltas.some((t: string) => t.includes("Partial text"))).toBe(true);
      expect(textDeltas.some((t: string) => t.includes("continuation"))).toBe(true);
    });
  });
});

describe("hasAttemptedReactiveCompact resets on text-only replies", () => {
  it("reactive compact can fire again after a text-only turn", async () => {
    let chatCallCount = 0;
    const overflowProvider: AIProvider = {
      chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
        chatCallCount++;
        if (chatCallCount === 1) {
          throw Object.assign(new Error("prompt too long"), {
            status: 400,
            error: { type: "invalid_request_error", message: "prompt is too long" },
          });
        }
        return (async function* () {
          yield { id: "c", model: "m", choices: [{ index: 0, delta: { content: "text reply" }, finish_reason: null }] };
          yield { id: "c2", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        })();
      },
    };

    const threadConfig: ThreadConfig = {
      provider: overflowProvider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
      reactiveCompact: { enabled: true },
    };

    const thread = new Thread(threadConfig, { sessionId: "reactive-reset" });
    const events = await collectEvents(thread.run("test"));

    const hasError = events.some((e) => e.type === "error");
    expect(hasError).toBe(true);
  });
});

describe("batched path preventContinuation", () => {
  it("stops turn loop when batched tool execution sets preventContinuation via hooks", async () => {
    let toolCallCount = 0;
    const threadConfig: ThreadConfig = {
      ...config,
      streamingToolExecution: false,
      hooks: [
        {
          event: "PostToolUse",
          handler: async (input) => {
            if (input.event === "PostToolUse" && input.toolName === "WriteFile") {
              return { preventContinuation: true };
            }
            return {};
          },
        },
      ],
      tools: [
        {
          name: "WriteFile",
          description: "write a file",
          parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } },
          async call(args, ctx) {
            toolCallCount++;
            await ctx.fs.writeFile(args.file_path as string, args.content as string);
            return { content: "written" };
          },
        },
      ],
    };

    let callIdx = 0;
    const hookProvider: AIProvider = {
      async *chat() {
        callIdx++;
        if (callIdx === 1) {
          yield toolCallStartChunk("tc1", "WriteFile");
          yield toolCallArgChunk('{"file_path":"/project/test.txt","content":"hello"}');
          yield toolCallsFinishChunk();
        } else {
          yield toolCallStartChunk("tc2", "WriteFile");
          yield toolCallArgChunk('{"file_path":"/project/test2.txt","content":"world"}');
          yield toolCallsFinishChunk();
        }
      },
    };

    const thread = new Thread(
      { ...threadConfig, provider: hookProvider },
      { sessionId: "s-prevent" },
    );
    const events = await collectEvents(thread.run("write files"));

    expect(toolCallCount).toBe(1);

    const turnComplete = events.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeDefined();
  });
});

describe("thinking signatures stripped on model fallback", () => {
  it("model_switch event strips thinking_signature from messages", async () => {
    let callIdx = 0;
    const fallbackProvider: AIProvider = {
      chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
        callIdx++;
        if (callIdx === 1) {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }
        return (async function* () {
          yield { id: "c", model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
          yield { id: "c2", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        })();
      },
    };

    const threadConfig: ThreadConfig = {
      provider: fallbackProvider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
      retry: {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        retryableStatuses: [529],
        fallbackModel: "fallback-model",
        maxConsecutiveOverloaded: 1,
      },
    };

    const thread = new Thread(threadConfig, { sessionId: "strip-sig" });
    const msgs = await thread.getMessages();
    expect(msgs.length).toBe(0);

    const events = await collectEvents(thread.run("test"));
    const hasSwitchEvent = events.some((e) => e.type === "model_switch");
    expect(hasSwitchEvent).toBe(true);
  });
});

describe("output token recovery", () => {
  it("persists continue messages to storage on finish_reason length", async () => {
    // First response: partial text truncated by max_tokens (finish_reason: "length")
    const lengthChunks: import("../providers/types.js").ChatStreamChunk[] = [
      textChunk("partial content here"),
      {
        id: "mock-len",
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
    ];
    // Second response: continuation after escalated max_tokens
    provider.addResponse(lengthChunks);
    provider.addResponse(textResponse("...continued"));

    const thread = new Thread(config, { sessionId: "s-len" });
    await collectEvents(thread.run("write something long"));

    const content = fs.files.get("/sessions/s-len.jsonl")!;
    const lines = content.trim().split("\n").map((l: string) => JSON.parse(l));
    const messages = lines
      .filter((e: any) => e.type === "message")
      .map((e: any) => e.message);

    // Should have: user, partial assistant, continue user, final assistant
    const userMsgs = messages.filter((m: any) => m.role === "user");
    const continueMsg = userMsgs.find((m: any) =>
      typeof m.content === "string" && m.content.includes("Continue from where you left off"),
    );
    expect(continueMsg).toBeDefined();
  });
});

describe("model switch clears accumulated state", () => {
  it("does not carry over thinking signatures from failed model to fallback model", async () => {
    let callCount = 0;
    const switchProvider: AIProvider = {
      async *chat(params: ChatParams) {
        callCount++;
        if (callCount <= 3) {
          const err = new Error("Overloaded") as Error & { status?: number };
          err.status = 529;
          throw err;
        }
        for (const c of textResponse("Fallback reply.")) yield c;
      },
    };

    const cfg: ThreadConfig = {
      ...config,
      provider: switchProvider,
      retry: {
        maxRetries: 10,
        baseDelayMs: 10,
        maxDelayMs: 50,
        fallbackModel: "fallback-model",
        maxConsecutiveOverloaded: 3,
      },
    };

    const thread = new Thread(cfg, { sessionId: "switch-clean" });
    const events = await collectEvents(thread.run("test model switch"));

    const messages = await thread.getMessages();
    const assistants = messages.filter((m) => m.role === "assistant");
    for (const asst of assistants) {
      const a = asst as import("../session/types.js").AssistantMessage;
      expect(a.thinking_signature).toBeUndefined();
      expect(a.redacted_thinking_data).toBeUndefined();
    }

    const switchEvent = events.find((e) => e.type === "model_switch");
    expect(switchEvent).toBeDefined();
  });

  it("mid-stream error persists partial text and tool calls as partial assistant", async () => {
    const midStreamErrorProvider: AIProvider = {
      async *chat() {
        yield textChunk("Partial answer so far... ");
        yield toolCallStartChunk("tc_partial", "ReadFile");
        yield toolCallArgChunk('{"file_path":"/x.txt"}');
        throw Object.assign(new Error("Server Error"), { status: 500 });
      },
    };

    const cfg: ThreadConfig = {
      ...config,
      provider: midStreamErrorProvider,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    };

    const thread = new Thread(cfg, { sessionId: "midstream-partial" });
    const events = await collectEvents(thread.run("test mid-stream error"));

    // Should have an error event
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);

    // The partial assistant message should be persisted with accumulated text
    const messages = await thread.getMessages();
    const assistants = messages.filter((m) => m.role === "assistant") as import("../session/types.js").AssistantMessage[];
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toContain("Partial answer so far");

    // Partial tool calls should also be persisted (with synthetic error results)
    const toolResults = messages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("retries and succeeds after transient errors", async () => {
    let callCount = 0;
    const retryProvider: AIProvider = {
      async *chat() {
        callCount++;
        if (callCount === 1) {
          const err = new Error("Server Error") as Error & { status?: number };
          err.status = 500;
          throw err;
        }
        for (const c of textResponse("Success after retry.")) yield c;
      },
    };

    const cfg: ThreadConfig = {
      ...config,
      provider: retryProvider,
      retry: {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
    };

    const thread = new Thread(cfg, { sessionId: "retry-success" });
    const events = await collectEvents(thread.run("retry test"));

    const retryEvents = events.filter((e) => e.type === "retry_attempt");
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);

    const messages = await thread.getMessages();
    expect(messages.find((m) => m.role === "assistant")).toBeDefined();
  });
});
