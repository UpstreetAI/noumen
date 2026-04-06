/**
 * Cross-cutting scenario regression tests.
 *
 * Each test replicates a specific failure pattern discovered during
 * debugging — multi-module interactions that individual unit tests miss.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  ErroringAIProvider,
  textResponse,
  toolCallResponse,
  multiToolCallResponse,
  textChunk,
  stopChunk,
  toolCallStartChunk,
  toolCallArgChunk,
  toolCallsFinishChunk,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type {
  StreamEvent,
  ChatMessage,
  AssistantMessage,
  ToolResultMessage,
} from "../session/types.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import { normalizeMessagesForAPI } from "../messages/normalize.js";
import { assertValidMessageSequence } from "../messages/invariants.js";
import { sanitizeForResume } from "../session/recovery.js";

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
    sessionDir: "/test-session",
    model: "mock-model",
    maxTokens: 4096,
  };
});

async function collectEvents(thread: Thread, prompt: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of thread.run(prompt)) {
    events.push(e);
  }
  return events;
}

// Scenario 1: Provider error during the second API call (after tool results are sent back).
// The first call returns 3 tool calls which execute successfully. The second call
// (with tool results in the conversation) throws mid-stream. The thread should
// surface an error but the transcript should remain API-valid after normalization.
describe("scenario: provider error after tool execution", () => {
  it("preserves completed tool results when provider errors on follow-up call", async () => {
    const errorProvider = new ErroringAIProvider();
    // First call: 3 tool calls — all succeed normally
    errorProvider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/b.txt" } },
        { id: "tc3", name: "ReadFile", args: { file_path: "/c.txt" } },
      ]),
    );
    // Second call: starts streaming text then errors mid-stream
    const secondCallChunks = [textChunk("Starting to "), textChunk("respond...")];
    errorProvider.addResponse(secondCallChunks, {
      errorAfter: 1,
      error: new Error("simulated provider crash"),
    });

    fs.files.set("/a.txt", "aaa");
    fs.files.set("/b.txt", "bbb");
    fs.files.set("/c.txt", "ccc");

    const config: ThreadConfig = {
      ...baseConfig,
      provider: errorProvider as unknown as AIProvider,
    };

    const thread = new Thread(config);
    const events: StreamEvent[] = [];
    try {
      for await (const e of thread.run("Read all files")) {
        events.push(e);
      }
    } catch {
      // Provider error propagates — expected
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    // All 3 tool results from the first call must be preserved
    const toolResults = normalized.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(3);
    // The real results should have actual file content, not synthetic errors
    const realResults = toolResults.filter(
      (m) => !(m as ToolResultMessage).isError,
    );
    expect(realResults.length).toBe(3);
  });

  it("transcript is valid after sanitizeForResume + normalize on error", async () => {
    const errorProvider = new ErroringAIProvider();
    errorProvider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "ReadFile", args: { file_path: "/a.txt" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/b.txt" } },
      ]),
    );
    // Provider errors immediately on second call (before yielding anything)
    errorProvider.addResponse([], {
      errorAfter: 0,
      error: new Error("502 Bad Gateway"),
    });

    fs.files.set("/a.txt", "content-a");
    fs.files.set("/b.txt", "content-b");

    const config: ThreadConfig = {
      ...baseConfig,
      provider: errorProvider as unknown as AIProvider,
    };

    const thread = new Thread(config);
    try {
      for await (const _e of thread.run("read")) { /* drain */ }
    } catch {
      // expected
    }

    const messages = await thread.getMessages();
    // Simulate what resume would do
    const { messages: sanitized } = sanitizeForResume(messages);
    const normalized = normalizeMessagesForAPI(sanitized);
    assertValidMessageSequence(normalized);

    const tools = normalized.filter((m) => m.role === "tool");
    expect(tools.length).toBe(2);
  });
});

// Scenario 2: Resume with partially-written tool results
describe("scenario: resume with partial tool results", () => {
  it("normalizes a broken transcript from a simulated crash", () => {
    const brokenTranscript: ChatMessage[] = [
      { role: "user", content: "run tools" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
          { id: "t2", type: "function", function: { name: "Bash", arguments: '{"command":"pwd"}' } },
        ],
      } as AssistantMessage,
      // Only t1 was persisted before crash
      { role: "tool", tool_call_id: "t1", content: "file1.txt\nfile2.txt" } as ToolResultMessage,
      // t2 is missing
    ];

    const normalized = normalizeMessagesForAPI(brokenTranscript);
    assertValidMessageSequence(normalized);

    // t2 should have a synthetic error result
    const t2Result = normalized.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).tool_call_id === "t2",
    ) as ToolResultMessage | undefined;
    expect(t2Result).toBeDefined();
    expect(t2Result!.isError).toBe(true);
  });
});

// Scenario 3: Provider returns duplicate tool_use IDs
describe("scenario: duplicate tool_use IDs from provider", () => {
  it("deduplicates without data loss", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "first call",
        tool_calls: [
          { id: "dup1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/a.txt"}' } },
        ],
      } as AssistantMessage,
      { role: "tool", tool_call_id: "dup1", content: "result A" } as ToolResultMessage,
      { role: "user", content: "again" },
      {
        role: "assistant",
        content: "second call with same ID",
        tool_calls: [
          { id: "dup1", type: "function", function: { name: "ReadFile", arguments: '{"file_path":"/b.txt"}' } },
        ],
      } as AssistantMessage,
      { role: "tool", tool_call_id: "dup1", content: "result B" } as ToolResultMessage,
    ];

    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    // Only one tool_use "dup1" should survive (from the first assistant)
    const toolUseIds = normalized
      .filter((m) => m.role === "assistant")
      .flatMap((m) => ((m as AssistantMessage).tool_calls ?? []).map((tc) => tc.id));
    const uniqueIds = new Set(toolUseIds);
    expect(uniqueIds.size).toBe(toolUseIds.length);

    // The text from the second assistant should survive (even though its tool_call was stripped)
    const textContents = normalized
      .filter((m) => m.role === "assistant")
      .map((m) => (m as AssistantMessage).content);
    expect(textContents.some((c) => typeof c === "string" && c.includes("second call"))).toBe(true);
  });
});

// Scenario 4: Context overflow with many concurrent tool results
describe("scenario: large concurrent tool results under budget", () => {
  it("handles 10 parallel tools returning large results", async () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({
      id: `tc${i}`,
      name: "ReadFile",
      args: { file_path: `/file${i}.txt` },
    }));

    provider.addResponse(multiToolCallResponse(calls));
    provider.addResponse(textResponse("All files read."));

    for (let i = 0; i < 10; i++) {
      fs.files.set(`/file${i}.txt`, "x".repeat(5000));
    }

    const thread = new Thread(baseConfig);
    const events = await collectEvents(thread, "Read everything");

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    const toolResults = normalized.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(10);
  });
});

// Scenario 5: Stale thinking signatures stripped during normalization
describe("scenario: stale thinking signature stripping", () => {
  it("strips signatures from non-final assistants, keeps final", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: "response 1",
        thinking_content: "thoughts",
        thinking_signature: "sig_old_model",
      } as AssistantMessage,
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: "response 2",
        thinking_content: "more thoughts",
        thinking_signature: "sig_current_model",
      } as AssistantMessage,
    ];

    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    const assistants = normalized.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants.length).toBe(2);
    expect(assistants[0].thinking_signature).toBeUndefined();
    expect(assistants[1].thinking_signature).toBe("sig_current_model");
  });
});

// Scenario 5b: Denial tracking — permission denied tool calls produce valid transcripts
// and denial counter increments correctly across multiple denied calls.
describe("scenario: denial tracking produces valid transcripts", () => {
  it("denied tool calls leave API-valid messages with synthetic error results", async () => {
    // Model tries to call a tool that will be denied by permission rules.
    // The denied tool_call should still have a tool result (the denial error)
    // and the transcript should be valid.
    provider.addResponse(
      multiToolCallResponse([
        { id: "tc1", name: "WriteFile", args: { file_path: "/secret.txt", content: "hack" } },
        { id: "tc2", name: "ReadFile", args: { file_path: "/ok.txt" } },
      ]),
    );
    provider.addResponse(textResponse("I see the first was denied."));

    fs.files.set("/ok.txt", "safe content");

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        rules: [{ tool: "WriteFile", permission: "deny" }],
        workingDirectories: ["/"],
      },
    };

    const thread = new Thread(config);
    const events = await collectEvents(thread, "write and read");

    const messages = await thread.getMessages();
    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    // Both tool_calls should have results
    const toolResults = normalized.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(toolResults.length).toBe(2);

    // WriteFile result should be a denial error
    const writeResult = toolResults.find((m) => m.tool_call_id === "tc1");
    expect(writeResult).toBeDefined();
    expect(writeResult!.isError).toBe(true);
    expect(typeof writeResult!.content === "string" && writeResult!.content).toContain("denied");

    // ReadFile result should succeed
    const readResult = toolResults.find((m) => m.tool_call_id === "tc2");
    expect(readResult).toBeDefined();
    expect(readResult!.isError).toBeFalsy();
  });
});

// Scenario 6: Error tool results with mixed content types
describe("scenario: error tool result sanitization", () => {
  it("handles error results with images, text, and invalid formats", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "screenshot" },
      {
        role: "assistant",
        content: "taking screenshot",
        tool_calls: [
          { id: "ss1", type: "function", function: { name: "Screenshot", arguments: "{}" } },
          { id: "ss2", type: "function", function: { name: "Screenshot", arguments: "{}" } },
        ],
      } as AssistantMessage,
      {
        role: "tool",
        tool_call_id: "ss1",
        content: [
          { type: "text", text: "Screenshot failed: display not available" },
          { type: "image", data: "aGVsbG8=", media_type: "image/png" },
        ],
        isError: true,
      } as ToolResultMessage,
      {
        role: "tool",
        tool_call_id: "ss2",
        content: [
          { type: "image", data: "d29ybGQ=", media_type: "image/png" },
        ],
        isError: true,
      } as ToolResultMessage,
    ];

    const normalized = normalizeMessagesForAPI(messages);
    assertValidMessageSequence(normalized);

    const toolResults = normalized.filter((m) => m.role === "tool") as ToolResultMessage[];
    expect(toolResults.length).toBe(2);

    // First result: should have text stripped of image
    expect(typeof toolResults[0].content).toBe("string");
    expect(toolResults[0].content).toContain("Screenshot failed");

    // Second result: image-only error should get fallback text
    expect(typeof toolResults[1].content).toBe("string");
    expect(toolResults[1].content).toContain("Error");
  });
});
