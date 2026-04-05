import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
  toolCallResponse,
  textChunk,
  stopChunk,
} from "./helpers.js";
import { Thread, type ThreadConfig } from "../thread.js";
import type { AIProvider, ChatParams, ChatStreamChunk } from "../providers/types.js";
import type { StreamEvent } from "../session/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import { DenialTracker } from "../permissions/denial-tracking.js";
import { containsShellExpansion } from "../permissions/rules.js";
import {
  runPostToolUseFailureHooks,
  runPreToolUseHooks,
} from "../hooks/runner.js";
import type { HookDefinition } from "../hooks/types.js";
import { classifyError, isRetryable } from "../retry/classify.js";
import { DEFAULT_RETRY_CONFIG } from "../retry/types.js";
import { isPrivateHost, isPrivateIP } from "../tools/web-fetch.js";
import { resolvePermission, isDangerousPath } from "../permissions/pipeline.js";
import type { PermissionContext } from "../permissions/types.js";
import { withRetry, CannotRetryError } from "../retry/engine.js";

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
  for await (const event of gen) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// Task 1: Abort signal linking
// ---------------------------------------------------------------------------
describe("abort signal linking", () => {
  it("abort() works when external signal is provided", async () => {
    const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      model: "m",
      choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null as string | null }],
    }));
    chunks.push({ id: "final", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    provider.addResponse(chunks);

    const externalController = new AbortController();
    const thread = new Thread(config, { sessionId: "abort-test" });
    const events: StreamEvent[] = [];

    for await (const event of thread.run("hi", { signal: externalController.signal })) {
      events.push(event);
      if (events.length >= 3) {
        thread.abort();
        break;
      }
    }

    expect(events.length).toBeLessThan(100);
  });

  it("external signal abort propagates to thread", async () => {
    const chunks: ChatStreamChunk[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      model: "m",
      choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null as string | null }],
    }));
    chunks.push({ id: "final", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    provider.addResponse(chunks);

    const externalController = new AbortController();
    const thread = new Thread(config, { sessionId: "ext-abort-test" });
    const events: StreamEvent[] = [];

    for await (const event of thread.run("hi", { signal: externalController.signal })) {
      events.push(event);
      if (events.length >= 3) {
        externalController.abort();
        break;
      }
    }

    expect(events.length).toBeLessThan(100);
  });

  it("passes signal to provider via ChatParams", async () => {
    provider.addResponse(textResponse("ok"));
    const thread = new Thread(config, { sessionId: "signal-pass" });
    await collectEvents(thread.run("test"));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].signal).toBeDefined();
    expect(provider.calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Deferred tool_use_start emission
// ---------------------------------------------------------------------------
describe("deferred tool_use_start emission", () => {
  it("emits tool_use_start when id and name arrive in separate chunks", async () => {
    const splitChunks: ChatStreamChunk[] = [
      {
        id: "s1", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "tc_split",
              type: "function",
              function: { name: undefined as unknown as string, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "s2", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "ReadFile", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "s3", model: "m",
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
        id: "s4", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    fs.files.set("/test.txt", "content");
    provider.addResponse(splitChunks);
    provider.addResponse(textResponse("done"));

    const thread = new Thread(config, { sessionId: "split-tc" });
    const events = await collectEvents(thread.run("read"));

    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts).toHaveLength(1);
    if (toolStarts[0].type === "tool_use_start") {
      expect(toolStarts[0].toolName).toBe("ReadFile");
      expect(toolStarts[0].toolUseId).toBe("tc_split");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4: Malformed JSON tool calls hard cap
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

// ---------------------------------------------------------------------------
// Task 5: Sandbox path traversal
// ---------------------------------------------------------------------------
describe("sandbox path traversal prevention", () => {
  it("docker-fs resolvePath blocks relative ../", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect(() => (dfs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("docker-fs resolvePath allows paths within workingDir", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect((dfs as any).resolvePath("subdir/file.txt")).toBe("/home/user/subdir/file.txt");
  });

  it("e2b-fs resolvePath blocks relative ../", async () => {
    const { E2BFs } = await import("../virtual/e2b-fs.js");
    const mockSandbox = {} as any;
    const efs = new E2BFs({ sandbox: mockSandbox, workingDir: "/home/user" });
    expect(() => (efs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("sprites-fs resolvePath blocks relative ../", async () => {
    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "t", spriteName: "s", workingDir: "/home/sprite" });
    expect(() => (sfs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("absolute paths are allowed through in remote FS backends", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect((dfs as any).resolvePath("/etc/passwd")).toBe("/etc/passwd");
  });
});

// ---------------------------------------------------------------------------
// Task 6: WebFetch SSRF
// ---------------------------------------------------------------------------
describe("WebFetch SSRF prevention", () => {
  it("blocks localhost", () => {
    expect(isPrivateHost("localhost")).toBe(true);
  });

  it("blocks 127.0.0.1", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
  });

  it("blocks 10.x.x.x", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16-31.x.x", () => {
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });

  it("blocks 192.168.x.x", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("blocks 169.254.x.x (link-local)", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });

  it("blocks ::1 and [::1]", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
  });

  it("allows public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("api.github.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 7: Permissions bugs
// ---------------------------------------------------------------------------
describe("permissions bug fixes", () => {
  describe("containsShellExpansion detects backticks", () => {
    it("detects backtick command substitution", () => {
      expect(containsShellExpansion("`whoami`")).toBe(true);
      expect(containsShellExpansion("/tmp/`id`/file")).toBe(true);
    });

    it("still detects dollar sign", () => {
      expect(containsShellExpansion("$(command)")).toBe(true);
      expect(containsShellExpansion("$HOME/file")).toBe(true);
    });

    it("still passes normal paths", () => {
      expect(containsShellExpansion("/home/user/file.txt")).toBe(false);
      expect(containsShellExpansion("~/file.txt")).toBe(false);
      expect(containsShellExpansion("./relative/path")).toBe(false);
    });
  });

  describe("DenialTracker.resetAfterFallback preserves totalDenials", () => {
    it("does not reset totalDenials", () => {
      const tracker = new DenialTracker({ maxConsecutive: 100, maxTotal: 5 });
      for (let i = 0; i < 5; i++) tracker.recordDenial();
      expect(tracker.shouldFallback()).toBe(true);

      tracker.resetAfterFallback();
      expect(tracker.getState().consecutiveDenials).toBe(0);
      expect(tracker.getState().totalDenials).toBe(5);
      expect(tracker.shouldFallback()).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 8: Hooks runner — blocking PostToolUseFailure
// ---------------------------------------------------------------------------
describe("runPostToolUseFailureHooks blocking error handling", () => {
  it("returns preventContinuation when a blocking hook throws", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        blocking: true,
        handler: () => { throw new Error("audit hook crashed"); },
      },
    ];

    const result = await runPostToolUseFailureHooks(hooks, {
      event: "PostToolUseFailure",
      toolName: "Bash",
      toolUseId: "tc1",
      sessionId: "s1",
      toolInput: {},
      toolOutput: "error output",
      error: "tool failed",
    });

    expect(result.preventContinuation).toBe(true);
    expect(result.updatedOutput).toContain("audit hook crashed");
  });

  it("swallows non-blocking hook errors", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        handler: () => { throw new Error("non-blocking error"); },
      },
    ];

    const result = await runPostToolUseFailureHooks(hooks, {
      event: "PostToolUseFailure",
      toolName: "Bash",
      toolUseId: "tc1",
      sessionId: "s1",
      toolInput: {},
      toolOutput: "error output",
      error: "tool failed",
    });

    expect(result.preventContinuation).toBeUndefined();
    expect(result.updatedOutput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 9: Anthropic thinking budget constraint
// ---------------------------------------------------------------------------
describe("Anthropic thinking budget constraint", () => {
  it("ensures effectiveMaxTokens > clampedBudget when maxOutputTokens is low", async () => {
    const { streamAnthropicChat } = await import("../providers/anthropic-shared.js");

    let capturedParams: Record<string, unknown> | undefined;
    const mockClient = {
      messages: {
        async *stream(params: Record<string, unknown>) {
          capturedParams = params;
          yield { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } };
          yield { type: "message_stop" };
        },
      },
    };

    const gen = streamAnthropicChat(mockClient as any, {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking: { type: "enabled", budgetTokens: 2048 },
    }, "claude-sonnet-4");

    for await (const _chunk of gen) { /* drain */ }

    expect(capturedParams).toBeDefined();
    const maxTokens = capturedParams!.max_tokens as number;
    const thinking = capturedParams!.thinking as { budget_tokens: number };
    expect(maxTokens).toBeGreaterThan(thinking.budget_tokens);
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  });
});

// ---------------------------------------------------------------------------
// Task 10: Retry engine
// ---------------------------------------------------------------------------
describe("retry engine fixes", () => {
  it("401 is not in default retryable statuses", () => {
    expect(DEFAULT_RETRY_CONFIG.retryableStatuses).not.toContain(401);
  });

  it("401 errors are not retryable with defaults", () => {
    const classified = classifyError({ status: 401, message: "Unauthorized" });
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(false);
  });

  it("429 errors are still retryable", () => {
    const classified = classifyError({ status: 429, message: "Rate limited" });
    expect(isRetryable(classified, DEFAULT_RETRY_CONFIG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 13: OpenAI compatMode omits stream_options
// ---------------------------------------------------------------------------
describe("OpenAI compatMode", () => {
  it("OllamaProvider inherits compatMode and omits stream_options", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const p = new OllamaProvider({ model: "test-model" });
    expect((p as any).compatMode).toBe(true);
  });

  it("default OpenAI provider does not use compatMode", async () => {
    const { OpenAIProvider } = await import("../providers/openai.js");
    const p = new OpenAIProvider({ apiKey: "test" });
    expect((p as any).compatMode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 14: Signal in ToolContext
// ---------------------------------------------------------------------------
describe("ToolContext receives signal", () => {
  it("signal is passed to tool context during run", async () => {
    let receivedSignal: AbortSignal | undefined;

    const toolConfig: ThreadConfig = {
      ...config,
      tools: [
        {
          name: "TestTool",
          description: "Test tool",
          parameters: { type: "object", properties: { x: { type: "string" } } },
          async call(_args, ctx) {
            receivedSignal = ctx.signal;
            return { content: "ok" };
          },
        },
      ],
    };

    const toolCallChunks: ChatStreamChunk[] = [
      {
        id: "t1", model: "m",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "tc_test", type: "function", function: { name: "TestTool", arguments: "" } }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "t2", model: "m",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":"val"}' } }] },
          finish_reason: null,
        }],
      },
      {
        id: "t3", model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ];

    provider.addResponse(toolCallChunks);
    provider.addResponse(textResponse("done"));

    const thread = new Thread(toolConfig, { sessionId: "signal-ctx" });
    await collectEvents(thread.run("test"));

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Comparison fix: acceptEdits returns "ask" not "deny" for out-of-cwd paths
// ---------------------------------------------------------------------------
describe("acceptEdits working-directory enforcement", () => {
  it("returns ask (not deny) for paths outside working directories", async () => {
    const tool = {
      name: "WriteFile",
      description: "Write a file",
      parameters: { type: "object" as const, properties: { file_path: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/home/user/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/home/user/project" };

    const decision = await resolvePermission(
      tool,
      { file_path: "/etc/outside/file.txt" },
      toolCtx,
      permCtx,
    );

    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("workingDirectory");
  });

  it("allows paths inside working directories in acceptEdits mode", async () => {
    const tool = {
      name: "WriteFile",
      description: "Write a file",
      parameters: { type: "object" as const, properties: { file_path: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/home/user/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/home/user/project" };

    const decision = await resolvePermission(
      tool,
      { file_path: "/home/user/project/src/file.txt" },
      toolCtx,
      permCtx,
    );

    expect(decision.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Comparison fix: retry engine totalAttempts budget
// ---------------------------------------------------------------------------
describe("retry engine totalAttempts budget", () => {
  it("does not exceed maxRetries total attempts even after fallback", async () => {
    let callCount = 0;

    async function* mockStream(): AsyncIterable<ChatStreamChunk> {
      callCount++;
      throw Object.assign(new Error("Overloaded"), { status: 529 });
    }

    const gen = withRetry(
      () => mockStream(),
      {
        ...DEFAULT_RETRY_CONFIG,
        model: "primary",
        fallbackModel: "fallback",
        maxConsecutiveOverloaded: 2,
        maxRetries: 6,
        baseDelayMs: 1,
      },
    );

    const events: StreamEvent[] = [];
    try {
      let result = await gen.next();
      while (!result.done) {
        events.push(result.value);
        result = await gen.next();
      }
    } catch {
      // expected exhaustion
    }

    expect(callCount).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Comparison fix: .noumen/ in dangerous path patterns
// ---------------------------------------------------------------------------
describe("dangerous path patterns include .noumen/", () => {
  it("detects .noumen/ as dangerous", () => {
    expect(isDangerousPath(".noumen/config.json")).toBe(true);
  });

  it("detects .noumen/sessions/ as dangerous", () => {
    expect(isDangerousPath(".noumen/sessions/abc.jsonl")).toBe(true);
  });

  it("still detects .claude/ as dangerous", () => {
    expect(isDangerousPath(".claude/settings.json")).toBe(true);
  });

  it("still detects .ssh/ as dangerous", () => {
    expect(isDangerousPath(".ssh/id_rsa")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Comparison fix: isPrivateIP for DNS rebinding prevention
// ---------------------------------------------------------------------------
describe("isPrivateIP for DNS rebinding", () => {
  it("blocks loopback IPs", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.0.0.2")).toBe(true);
  });

  it("blocks RFC-1918 ranges", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });

  it("blocks link-local", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("[::1]")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("93.184.216.34")).toBe(false);
  });
});
