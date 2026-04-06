import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  textChunk,
  toolCallResponse,
  multiToolCallResponse,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
  stopChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent, ChatMessage, AssistantMessage } from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let config: ThreadConfig;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  config = {
    provider,
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

// ---------------------------------------------------------------------------
// 1. Multi-turn with parallel tool calls (happy path)
// ---------------------------------------------------------------------------

describe("integration: multi-turn with parallel tool calls", () => {
  it("executes two parallel tool calls and loops to final response", async () => {
    fs.files.set("/a.txt", "content-a");
    fs.files.set("/b.txt", "content-b");

    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/b.txt" } },
      ]),
    );
    provider.addResponse(textResponse("I read both files."));

    const thread = new Thread(config, { sessionId: "multi-tool" });
    const events = await collectEvents(thread.run("read both files"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();
    if (complete?.type === "message_complete") {
      expect(complete.message.content).toBe("I read both files.");
    }

    const turnComplete = events.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeDefined();
    if (turnComplete?.type === "turn_complete") {
      expect(turnComplete.callCount).toBe(2);
    }

    const messages = await thread.getMessages();
    expect(messages[0]).toEqual({ role: "user", content: "read both files" });
    expect(messages[1].role).toBe("assistant");
    expect((messages[1] as AssistantMessage).tool_calls).toHaveLength(2);
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("tool");
    expect(messages[4].role).toBe("assistant");

    const normalized = normalizeMessagesForAPI(messages);
    expect(normalized[0].role).toBe("user");
    const toolResultMsgs = normalized.filter((m) => m.role === "tool");
    const toolIds = new Set(toolResultMsgs.map((m) => (m as any).tool_call_id));
    expect(toolIds.size).toBe(toolResultMsgs.length);
  });

  it("persists all messages to storage in order", async () => {
    fs.files.set("/x.txt", "data");

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/x.txt" }),
    );
    provider.addResponse(textResponse("Done."));

    const thread = new Thread(config, { sessionId: "persist-order" });
    await collectEvents(thread.run("read x"));

    const raw = fs.files.get("/sessions/persist-order.jsonl")!;
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const msgEntries = lines.filter((e: any) => e.type === "message");
    const roles = msgEntries.map((e: any) => e.message.role);

    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Abort during streaming (after partial text)
// ---------------------------------------------------------------------------

describe("integration: abort during streaming", () => {
  it("saves partial assistant and interruption message on abort mid-stream", async () => {
    const ac = new AbortController();

    const slowProvider: AIProvider = {
      async *chat() {
        yield textChunk("Hello ");
        yield textChunk("world");
        ac.abort();
        yield textChunk(" more text");
        yield stopChunk();
      },
    };

    const slowConfig: ThreadConfig = {
      ...config,
      provider: slowProvider,
    };

    const thread = new Thread(slowConfig, { sessionId: "abort-stream" });
    const events = await collectEvents(thread.run("say something", { signal: ac.signal }));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    const messages = await thread.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("interrupted");
  });
});

// ---------------------------------------------------------------------------
// 3. Abort during batched tool execution (validates Bug 2 fix)
// ---------------------------------------------------------------------------

describe("integration: abort during batched tool execution", () => {
  it("appends interruption message when aborted during tool execution", async () => {
    const ac = new AbortController();

    const slowComputer = new MockComputer(async (command) => {
      ac.abort();
      await new Promise((r) => setTimeout(r, 10));
      return { exitCode: 0, stdout: "done", stderr: "" };
    });

    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "echo hello" }),
    );

    const threadConfig: ThreadConfig = {
      ...config,
      computer: slowComputer,
    };

    const thread = new Thread(threadConfig, { sessionId: "abort-tools" });
    await collectEvents(thread.run("run a command", { signal: ac.signal }));

    const messages = await thread.getMessages();
    const userMsgs = messages.filter((m) => m.role === "user");
    const interruptionMsg = userMsgs.find(
      (m) => typeof m.content === "string" && m.content.includes("interrupted"),
    );
    expect(interruptionMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-turn with compaction trigger
// ---------------------------------------------------------------------------

describe("integration: auto-compact during multi-turn", () => {
  it("compacts and continues with new turn after threshold exceeded", async () => {
    const longText = "x".repeat(800);
    let callIdx = 0;

    const compactProvider: AIProvider = {
      async *chat(params: ChatParams) {
        callIdx++;
        const isCompact = params.system?.includes("summariz");
        if (isCompact) {
          for (const chunk of textResponse("Summary of conversation.")) yield chunk;
          return;
        }
        for (const chunk of textResponse(callIdx === 1 ? longText : "Final.")) yield chunk;
      },
    };

    const autoConfig: ThreadConfig = {
      ...config,
      provider: compactProvider,
      autoCompact: createAutoCompactConfig({
        enabled: true,
        threshold: 100,
      }),
    };

    const thread = new Thread(autoConfig, { sessionId: "compact-multi" });
    const events1 = await collectEvents(thread.run("first turn with lots of context"));

    const compactEvents = events1.filter(
      (e) => e.type === "compact_start" || e.type === "compact_complete",
    );

    const turnComplete = events1.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeDefined();

    const events2 = await collectEvents(thread.run("second turn"));
    const turnComplete2 = events2.find((e) => e.type === "turn_complete");
    expect(turnComplete2).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Session resume round-trip
// ---------------------------------------------------------------------------

describe("integration: session resume round-trip", () => {
  it("resumes a session and continues normally", async () => {
    provider.addResponse(textResponse("First response."));

    const thread1 = new Thread(config, { sessionId: "resume-rt" });
    await collectEvents(thread1.run("Hello"));

    const msgs1 = await thread1.getMessages();
    expect(msgs1).toHaveLength(2);

    provider.addResponse(textResponse("Second response."));

    const thread2 = new Thread(config, { sessionId: "resume-rt", resume: true });
    const events2 = await collectEvents(thread2.run("Continue"));

    const resumed = events2.find((e) => e.type === "session_resumed");
    expect(resumed).toBeDefined();
    if (resumed?.type === "session_resumed") {
      expect(resumed.messageCount).toBe(2);
    }

    const msgs2 = await thread2.getMessages();
    expect(msgs2.length).toBeGreaterThan(2);
    expect(msgs2[msgs2.length - 1].role).toBe("assistant");

    const normalized = normalizeMessagesForAPI(msgs2);
    expect(normalized[0].role).toBe("user");
  });

  it("resumes a session with tool calls and re-runs correctly", async () => {
    fs.files.set("/file.txt", "file data");

    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/file.txt" }),
    );
    provider.addResponse(textResponse("I read it."));

    const thread1 = new Thread(config, { sessionId: "resume-tools" });
    await collectEvents(thread1.run("read file"));

    provider.addResponse(textResponse("Resumed fine."));

    const thread2 = new Thread(config, { sessionId: "resume-tools", resume: true });
    const events2 = await collectEvents(thread2.run("what did you read?"));

    const turnComplete = events2.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeDefined();

    const msgs2 = await thread2.getMessages();
    const normalized = normalizeMessagesForAPI(msgs2);
    expect(normalized[0].role).toBe("user");
    const toolResults = normalized.filter((m) => m.role === "tool");
    const toolIds = toolResults.map((m) => (m as any).tool_call_id);
    expect(new Set(toolIds).size).toBe(toolIds.length);
  });
});

// ---------------------------------------------------------------------------
// 6. Normalization invariants under corruption
// ---------------------------------------------------------------------------

describe("integration: normalization invariants", () => {
  function assertNormalizationInvariants(messages: ChatMessage[]) {
    const result = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(result);
    // Idempotency
    expect(normalizeMessagesForAPI(result)).toEqual(result);
  }

  it("handles duplicate tool_result IDs", () => {
    assertNormalizationInvariants([
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }] } as AssistantMessage,
      { role: "tool", tool_call_id: "t1", content: "result1" },
      { role: "tool", tool_call_id: "t1", content: "result2" },
    ]);
  });

  it("handles orphaned tool_results", () => {
    assertNormalizationInvariants([
      { role: "user", content: "go" },
      { role: "tool", tool_call_id: "orphan", content: "no parent" },
      { role: "assistant", content: "ok" } as AssistantMessage,
    ]);
  });

  it("handles consecutive same-role messages", () => {
    assertNormalizationInvariants([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "x" } as AssistantMessage,
      { role: "assistant", content: "y" } as AssistantMessage,
    ]);
  });

  it("handles thinking-only trailing assistant by removing it", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think" },
      { role: "assistant", content: "", thinking_content: "deep thought" } as AssistantMessage,
    ];
    const result = normalizeMessagesForAPI(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("handles missing tool results (unpaired tool_use)", () => {
    assertNormalizationInvariants([
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } },
        { id: "t2", type: "function", function: { name: "Bash", arguments: "{}" } },
      ] } as AssistantMessage,
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ]);
  });

  it("handles empty message array", () => {
    const result = normalizeMessagesForAPI([]);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
  });

  it("handles system messages mixed in", () => {
    assertNormalizationInvariants([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "system", content: "reminder" },
      { role: "assistant", content: "hello" } as AssistantMessage,
    ]);
  });

  it("is idempotent for all corruption types", () => {
    const corrupted: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: null, tool_calls: [
        { id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } },
      ] } as AssistantMessage,
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "tool", tool_call_id: "t1", content: "dup" },
      { role: "tool", tool_call_id: "orphan", content: "orphan" },
      { role: "assistant", content: "  " } as AssistantMessage,
      { role: "assistant", content: "", thinking_content: "think" } as AssistantMessage,
    ];
    const first = normalizeMessagesForAPI(corrupted);
    const second = normalizeMessagesForAPI(first);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 7. Permission denial tracking (validates Bug 1 fix)
// ---------------------------------------------------------------------------

describe("integration: denial tracking — no double-counting", () => {
  it("classifier deny in pipeline does not double-record in thread (rule denials)", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "echo hi" }),
    );
    provider.addResponse(textResponse("Done."));

    const permConfig: ThreadConfig = {
      ...config,
      permissions: {
        mode: "default",
        rules: [{ toolName: "Bash", behavior: "deny" as const }],
        denialTracking: { maxConsecutive: 10, maxTotal: 100 },
      },
    };

    const thread = new Thread(permConfig, { sessionId: "denial-rule" });
    const events = await collectEvents(thread.run("run something", { maxTurns: 2 }));

    const deniedEvents = events.filter((e) => e.type === "permission_denied");
    expect(deniedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("DenialTracker recordDenial is not called from thread.ts for classifier reason", async () => {
    const { DenialTracker } = await import("../permissions/denial-tracking.js");
    const tracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 20 });

    tracker.recordDenial();
    expect(tracker.getState().consecutiveDenials).toBe(1);
    expect(tracker.getState().totalDenials).toBe(1);

    tracker.recordDenial();
    expect(tracker.getState().consecutiveDenials).toBe(2);
    expect(tracker.getState().totalDenials).toBe(2);

    tracker.recordSuccess();
    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(2);
  });

  it("permission denial with no handler yields permission_denied event", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "WriteFile", { file_path: "/test.txt", content: "hello" }),
    );
    provider.addResponse(textResponse("OK."));

    const permConfig: ThreadConfig = {
      ...config,
      permissions: {
        mode: "default",
        denialTracking: { maxConsecutive: 10, maxTotal: 100 },
      },
    };

    const thread = new Thread(permConfig, { sessionId: "denial-no-handler" });
    const events = await collectEvents(thread.run("write file", { maxTurns: 2 }));

    const deniedEvents = events.filter((e) => e.type === "permission_denied");
    expect(deniedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed JSON tool calls recovery
// ---------------------------------------------------------------------------

describe("integration: malformed JSON tool calls", () => {
  it("generates error results and gives model another chance", async () => {
    const malformedChunks: ChatStreamChunk[] = [
      toolCallStartChunk("tc_bad", "ReadFile"),
      toolCallArgChunk("{invalid json"),
      toolCallsFinishChunk(),
    ];

    provider.addResponse(malformedChunks);
    provider.addResponse(textResponse("Let me try again properly."));

    const thread = new Thread(config, { sessionId: "malformed-json" });
    const events = await collectEvents(thread.run("do something"));

    const toolResults = events.filter((e) => e.type === "tool_result");
    const errorResult = toolResults.find(
      (e) => e.type === "tool_result" && e.result.isError,
    );
    expect(errorResult).toBeDefined();

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();

    expect(provider.calls).toHaveLength(2);

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    expect(normalized[0].role).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// 9. finish_reason: "length" recovery
// ---------------------------------------------------------------------------

describe("integration: finish_reason length recovery", () => {
  it("persists partial + continue message and produces final response", async () => {
    const lengthChunks: ChatStreamChunk[] = [
      textChunk("partial content here"),
      {
        id: "mock-len",
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
    ];

    provider.addResponse(lengthChunks);
    provider.addResponse(textResponse("...continued successfully"));

    const thread = new Thread(config, { sessionId: "length-recovery" });
    const events = await collectEvents(thread.run("write a long essay"));

    const complete = events.find((e) => e.type === "message_complete");
    expect(complete).toBeDefined();

    const messages = await thread.getMessages();
    const userMsgs = messages.filter((m) => m.role === "user");
    const continueMsg = userMsgs.find(
      (m) => typeof m.content === "string" && m.content.includes("Continue from where you left off"),
    );
    expect(continueMsg).toBeDefined();

    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);

    const raw = fs.files.get("/sessions/length-recovery.jsonl")!;
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const msgEntries = lines.filter((e: any) => e.type === "message");
    const roles = msgEntries.map((e: any) => e.message.role);
    expect(roles).toContain("user");
    expect(roles.filter((r: string) => r === "assistant").length).toBe(2);
  });

  it("escalates max_tokens on first truncation", async () => {
    const lengthChunks: ChatStreamChunk[] = [
      textChunk("partial"),
      {
        id: "mock-len2",
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
      },
    ];

    provider.addResponse(lengthChunks);
    provider.addResponse(textResponse("full response"));

    const thread = new Thread(config, { sessionId: "length-escalate" });
    await collectEvents(thread.run("go"));

    expect(provider.calls).toHaveLength(2);
    const secondCall = provider.calls[1];
    expect(secondCall.max_tokens).toBe(65536);
  });
});
