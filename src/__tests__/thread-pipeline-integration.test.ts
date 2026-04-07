import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  ErroringAIProvider,
  textResponse,
  textChunk,
  toolCallResponse,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
  stopChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent, AssistantMessage, ToolResultMessage } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";

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
  };
});

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Pipeline seam integration", () => {
  // -----------------------------------------------------------------------
  // 1. Stream error -> buildPartialResults persistence
  // -----------------------------------------------------------------------
  describe("stream error -> buildPartialResults persistence", () => {
    it("persists partial assistant message and surfaces error when provider throws mid-stream", async () => {
      const errProvider = new ErroringAIProvider();
      errProvider.addResponse(
        [textChunk("Hello "), textChunk("world"), stopChunk()],
        { errorAfter: 2, error: new Error("stream exploded") },
      );
      errProvider.addResponse(textResponse("recovered"));

      const config: ThreadConfig = {
        ...baseConfig,
        provider: errProvider,
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      };

      const thread = new Thread(config, { sessionId: "stream-err" });
      const events = await collectEvents(thread.run("say hello"));

      const hasError = events.some((e) => e.type === "error");
      const hasRetry = events.some((e) => e.type === "retry_attempt");
      expect(hasError || hasRetry).toBe(true);

      const msgs = await thread.getMessages();
      const normalized = normalizeMessagesForAPI(msgs);
      assertValidMessageSequence(normalized);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Provider error -> reactive compact recovery -> retry
  // -----------------------------------------------------------------------
  describe("provider error -> reactive compact recovery -> retry", () => {
    it("emits compact events and delivers final text after reactive compact succeeds", async () => {
      const entry1 = JSON.stringify({
        type: "message", uuid: "u1", parentUuid: null, sessionId: "reactive-recovery",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "first question" },
      });
      const entry2 = JSON.stringify({
        type: "message", uuid: "u2", parentUuid: "u1", sessionId: "reactive-recovery",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "first answer with lots of content to compact" },
      });
      const entry3 = JSON.stringify({
        type: "message", uuid: "u3", parentUuid: "u2", sessionId: "reactive-recovery",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "second question" },
      });
      const entry4 = JSON.stringify({
        type: "message", uuid: "u4", parentUuid: "u3", sessionId: "reactive-recovery",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "second answer with more content" },
      });
      fs.files.set(
        "/sessions/reactive-recovery.jsonl",
        [entry1, entry2, entry3, entry4].join("\n") + "\n",
      );

      let chatCallCount = 0;
      const overflowProvider: AIProvider = {
        chat(params: ChatParams): AsyncIterable<ChatStreamChunk> {
          chatCallCount++;
          if (chatCallCount === 1) {
            throw Object.assign(
              new Error("prompt is too long: 200000 tokens > 100000 maximum"),
              { status: 400 },
            );
          }
          if (params.system?.includes("summariz")) {
            return (async function* () {
              for (const c of textResponse("Conversation summary.")) yield c;
            })();
          }
          return (async function* () {
            for (const c of textResponse("Final answer after compact.")) yield c;
          })();
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: overflowProvider,
        reactiveCompact: { enabled: true },
      };

      const thread = new Thread(config, { sessionId: "reactive-recovery", resume: true });
      const events = await collectEvents(thread.run("follow-up question"));

      const compactStarts = events.filter((e) => e.type === "compact_start");
      const compactCompletes = events.filter((e) => e.type === "compact_complete");
      expect(compactStarts.length).toBeGreaterThanOrEqual(1);
      expect(compactCompletes.length).toBeGreaterThanOrEqual(1);

      expect(chatCallCount).toBeGreaterThanOrEqual(2);

      const msgs = await thread.getMessages();
      assertValidMessageSequence(normalizeMessagesForAPI(msgs));
    });
  });

  // -----------------------------------------------------------------------
  // 3. Provider error -> buildPartialResults with tool calls
  // -----------------------------------------------------------------------
  describe("provider error -> buildPartialResults with tool calls", () => {
    it("persists partial assistant with tool_calls and synthetic error results when provider throws", async () => {
      let callCount = 0;
      const errorProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield toolCallStartChunk("tc_1", "ReadFile");
            yield toolCallArgChunk('{"file_path":"/a.txt"}');
            throw new Error("connection reset");
          }
          for (const c of textResponse("recovered")) yield c;
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: errorProvider,
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      };

      const thread = new Thread(config, { sessionId: "partial-tools" });
      const events = await collectEvents(thread.run("read file"));

      const msgs = await thread.getMessages();
      const normalized = normalizeMessagesForAPI(msgs);
      assertValidMessageSequence(normalized);

      const assistantsWithTools = msgs.filter(
        (m) => m.role === "assistant" && (m as AssistantMessage).tool_calls?.length,
      );
      for (const asst of assistantsWithTools) {
        const toolCallIds = new Set(
          ((asst as AssistantMessage).tool_calls ?? []).map((tc) => tc.id),
        );
        for (const id of toolCallIds) {
          const hasResult = msgs.some(
            (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === id,
          );
          expect(hasResult).toBe(true);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Output token recovery via handleFinishReason
  // -----------------------------------------------------------------------
  describe("output token recovery via handleFinishReason", () => {
    it("escalates max_tokens and persists continue message on finish_reason length", async () => {
      let callCount = 0;
      const truncProvider: AIProvider = {
        async *chat(params: ChatParams) {
          callCount++;
          if (callCount === 1) {
            yield textChunk("Partial answer...");
            yield {
              id: "len-1",
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "length" }],
              usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 },
            };
          } else {
            yield textChunk("...complete.");
            yield stopChunk({ prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 });
          }
        },
      };

      const config: ThreadConfig = { ...baseConfig, provider: truncProvider };
      const thread = new Thread(config, { sessionId: "output-recovery" });
      const events = await collectEvents(thread.run("write something"));

      expect(callCount).toBe(2);

      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text);
      expect(textDeltas.some((t: string) => t.includes("Partial answer"))).toBe(true);
      expect(textDeltas.some((t: string) => t.includes("complete"))).toBe(true);

      const content = fs.files.get("/sessions/output-recovery.jsonl")!;
      const lines = content.trim().split("\n").map((l: string) => JSON.parse(l));
      const messages = lines
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message);
      const continueMsg = messages.find(
        (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("Continue"),
      );
      expect(continueMsg).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Model switch -> resetAccumulator
  // -----------------------------------------------------------------------
  describe("model switch -> resetAccumulator", () => {
    it("discards accumulated state from failed model and responds only from fallback", async () => {
      let callCount = 0;
      const switchProvider: AIProvider = {
        async *chat(params: ChatParams) {
          callCount++;
          if (callCount <= 3) {
            throw Object.assign(new Error("Overloaded"), { status: 529 });
          }
          for (const c of textResponse("Fallback reply.")) yield c;
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: switchProvider,
        retry: {
          maxRetries: 10,
          baseDelayMs: 1,
          maxDelayMs: 10,
          fallbackModel: "fallback-model",
          maxConsecutiveOverloaded: 3,
        },
      };

      const thread = new Thread(config, { sessionId: "model-switch" });
      const events = await collectEvents(thread.run("test switch"));

      const switchEvent = events.find((e) => e.type === "model_switch");
      expect(switchEvent).toBeDefined();

      const msgs = await thread.getMessages();
      const assistants = msgs.filter((m) => m.role === "assistant");
      for (const asst of assistants) {
        expect((asst as AssistantMessage).thinking_signature).toBeUndefined();
        expect((asst as AssistantMessage).redacted_thinking_data).toBeUndefined();
      }

      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text)
        .join("");
      expect(textDeltas).toContain("Fallback reply");
    });
  });

  // -----------------------------------------------------------------------
  // 6. Abort mid-stream -> buildPartialResults without interruption tag
  // -----------------------------------------------------------------------
  describe("abort mid-stream -> buildPartialResults without interruption tag", () => {
    it("persists partial results and appends interruption user message on abort", async () => {
      const config: ThreadConfig = {
        ...baseConfig,
        streamingToolExecution: true,
        tools: [
          {
            name: "SlowTool",
            description: "blocks until abort",
            parameters: { type: "object", properties: {} },
            isConcurrencySafe: true,
            async call(_args, ctx) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 10_000);
                ctx.signal?.addEventListener("abort", () => {
                  clearTimeout(timer);
                  resolve();
                });
              });
              return { content: "slow-done" };
            },
          },
        ],
      };

      const ac = new AbortController();
      const abortProvider: AIProvider = {
        async *chat() {
          yield textChunk("Starting... ");
          yield toolCallStartChunk("tc_slow", "SlowTool");
          yield toolCallArgChunk("{}");
          yield toolCallsFinishChunk();
        },
      };

      const thread = new Thread(
        { ...config, provider: abortProvider },
        { sessionId: "abort-partial" },
      );

      setTimeout(() => ac.abort(), 150);
      await collectEvents(thread.run("test abort", { signal: ac.signal }));

      const msgs = await thread.getMessages();
      const normalized = normalizeMessagesForAPI(msgs);
      assertValidMessageSequence(normalized);

      const assistantsWithTools = msgs.filter(
        (m) => m.role === "assistant" && (m as AssistantMessage).tool_calls?.length,
      );
      for (const asst of assistantsWithTools) {
        const toolCallIds = ((asst as AssistantMessage).tool_calls ?? []).map((tc) => tc.id);
        for (const id of toolCallIds) {
          expect(
            msgs.some((m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === id),
          ).toBe(true);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // 7. consumeStream -> handleFinishReason -> executeToolsStep full pipeline
  // -----------------------------------------------------------------------
  describe("full pipeline: stream -> accumulate -> execute -> respond", () => {
    it("streams 2 tool calls, executes both, and model responds with final text", async () => {
      let tool1Called = false;
      let tool2Called = false;

      const config: ThreadConfig = {
        ...baseConfig,
        tools: [
          {
            name: "ReadFile",
            description: "read a file",
            parameters: { type: "object", properties: { file_path: { type: "string" } } },
            isReadOnly: true,
            async call(args) {
              if (args.file_path === "/a.txt") tool1Called = true;
              if (args.file_path === "/b.txt") tool2Called = true;
              return { content: `content of ${args.file_path}` };
            },
          },
        ],
      };

      let callCount = 0;
      const multiProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield {
              id: "c1", model: "m",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "tc_a",
                    type: "function" as const,
                    function: { name: "ReadFile", arguments: "" },
                  }],
                },
                finish_reason: null,
              }],
            };
            yield {
              id: "c2", model: "m",
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] },
                finish_reason: null,
              }],
            };
            yield {
              id: "c3", model: "m",
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"/a.txt"}' } }] },
                finish_reason: null,
              }],
            };
            yield {
              id: "c4", model: "m",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 1,
                    id: "tc_b",
                    type: "function" as const,
                    function: { name: "ReadFile", arguments: "" },
                  }],
                },
                finish_reason: null,
              }],
            };
            yield {
              id: "c5", model: "m",
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 1, function: { arguments: '{"file_path":"/b.txt"}' } }] },
                finish_reason: null,
              }],
            };
            yield {
              id: "c6", model: "m",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
            };
          } else {
            yield textChunk("I read both files.");
            yield stopChunk({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
          }
        },
      };

      const thread = new Thread(
        { ...config, provider: multiProvider },
        { sessionId: "full-pipeline" },
      );
      const events = await collectEvents(thread.run("read both files"));

      expect(tool1Called).toBe(true);
      expect(tool2Called).toBe(true);
      expect(callCount).toBe(2);

      const toolResults = events.filter((e) => e.type === "tool_result");
      expect(toolResults).toHaveLength(2);

      const toolStarts = events.filter((e) => e.type === "tool_use_start");
      expect(toolStarts).toHaveLength(2);

      const textDeltas = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as any).text)
        .join("");
      expect(textDeltas).toContain("I read both files");

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();
      if (turnComplete?.type === "turn_complete") {
        expect(turnComplete.callCount).toBe(2);
      }

      const msgs = await thread.getMessages();
      assertValidMessageSequence(normalizeMessagesForAPI(msgs));

      const toolMsgs = msgs.filter((m) => m.role === "tool") as ToolResultMessage[];
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs.some((m) => m.content?.toString().includes("content of /a.txt"))).toBe(true);
      expect(toolMsgs.some((m) => m.content?.toString().includes("content of /b.txt"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Structured output — final_response mode
  // -----------------------------------------------------------------------
  describe("structured output — final_response mode", () => {
    const schema = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      name: "result",
      strict: true,
    };

    it("emits structured_output event and stops on StructuredOutput tool call", async () => {
      let callCount = 0;
      const soProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield toolCallStartChunk("tc_so", "StructuredOutput");
            yield toolCallArgChunk('{"data":{"answer":"42"}}');
            yield toolCallsFinishChunk();
          } else {
            for (const c of textResponse("should not reach")) yield c;
          }
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: soProvider,
        outputFormat: schema,
        structuredOutputMode: "final_response",
      };

      const thread = new Thread(config, { sessionId: "so-final" });
      const events = await collectEvents(thread.run("answer"));

      const soEvents = events.filter((e) => e.type === "structured_output");
      expect(soEvents).toHaveLength(1);
      expect((soEvents[0] as any).data).toEqual({ answer: "42" });

      const turnComplete = events.find((e) => e.type === "turn_complete");
      expect(turnComplete).toBeDefined();

      expect(callCount).toBe(1);
    });

    it("emits structured_output with raw args when inner data parse succeeds but has no data key", async () => {
      const soProvider: AIProvider = {
        async *chat() {
          yield toolCallStartChunk("tc_so2", "StructuredOutput");
          yield toolCallArgChunk('{"answer":"direct"}');
          yield toolCallsFinishChunk();
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: soProvider,
        outputFormat: schema,
        structuredOutputMode: "final_response",
      };

      const thread = new Thread(config, { sessionId: "so-no-data-key" });
      const events = await collectEvents(thread.run("answer"));

      const soEvents = events.filter((e) => e.type === "structured_output");
      expect(soEvents).toHaveLength(1);
      // When no `data` key, falls back to the entire parsed object
      expect((soEvents[0] as any).data).toEqual({ answer: "direct" });
    });

    it("treats malformed-JSON StructuredOutput args as a malformed tool call", async () => {
      let callCount = 0;
      const soProvider: AIProvider = {
        async *chat() {
          callCount++;
          if (callCount === 1) {
            yield toolCallStartChunk("tc_so3", "StructuredOutput");
            yield toolCallArgChunk("not valid json");
            yield toolCallsFinishChunk();
          } else {
            for (const c of textResponse("gave up")) yield c;
          }
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: soProvider,
        outputFormat: schema,
        structuredOutputMode: "final_response",
      };

      const thread = new Thread(config, { sessionId: "so-malformed" });
      const events = await collectEvents(thread.run("answer", { maxTurns: 2 }));

      // The malformed tool call triggers a retry, not a structured_output
      const soEvents = events.filter((e) => e.type === "structured_output");
      expect(soEvents).toHaveLength(0);
      expect(callCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Structured output — alongside_tools mode
  // -----------------------------------------------------------------------
  describe("structured output — alongside_tools mode", () => {
    const schema = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        properties: { result: { type: "number" } },
        required: ["result"],
      },
      name: "calc_result",
    };

    it("emits structured_output when model text is valid JSON", async () => {
      const jsonProvider: AIProvider = {
        async *chat() {
          yield textChunk('{"result": 99}');
          yield stopChunk();
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: jsonProvider,
        outputFormat: schema,
      };

      const thread = new Thread(config, { sessionId: "so-alongside-ok" });
      const events = await collectEvents(thread.run("calculate"));

      const soEvents = events.filter((e) => e.type === "structured_output");
      expect(soEvents).toHaveLength(1);
      expect((soEvents[0] as any).data).toEqual({ result: 99 });

      const msgComplete = events.find((e) => e.type === "message_complete");
      expect(msgComplete).toBeDefined();
    });

    it("does not emit structured_output when model text is not valid JSON", async () => {
      const plainProvider: AIProvider = {
        async *chat() {
          yield textChunk("This is plain text, not JSON");
          yield stopChunk();
        },
      };

      const config: ThreadConfig = {
        ...baseConfig,
        provider: plainProvider,
        outputFormat: schema,
      };

      const thread = new Thread(config, { sessionId: "so-alongside-nojson" });
      const events = await collectEvents(thread.run("describe"));

      const soEvents = events.filter((e) => e.type === "structured_output");
      expect(soEvents).toHaveLength(0);

      const msgComplete = events.find((e) => e.type === "message_complete");
      expect(msgComplete).toBeDefined();
    });
  });
});
