import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeToolCall, type ToolExecutionContext } from "../tools/execution-pipeline.js";
import type { ToolCallContent, StreamEvent } from "../session/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { ZodLikeSchema, SafeParseResult } from "../utils/zod.js";
import type { PermissionContext, PermissionHandler } from "../permissions/types.js";
import type { HookDefinition } from "../hooks/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { DenialTracker } from "../permissions/denial-tracking.js";
import { NoopTracer } from "../tracing/noop.js";
import { MockFs, MockComputer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Mock resolvePermission — the real one touches node:fs for path resolution
// ---------------------------------------------------------------------------

const mockResolvePermission = vi.fn();
vi.mock("../permissions/pipeline.js", () => ({
  resolvePermission: (...args: unknown[]) => mockResolvePermission(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTc(name: string, id = "tc_1"): ToolCallContent {
  return {
    id,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

function makeTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "TestTool",
    description: "A test tool",
    parameters: { type: "object", properties: {}, required: [] },
    call: async () => ({ content: "ok" }),
    ...overrides,
  };
}

function makeToolCtx(): ToolContext {
  return {
    fs: new MockFs(),
    computer: new MockComputer(),
    cwd: "/test",
  };
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry([]);
  for (const t of tools) reg.register(t);
  return reg;
}

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    registry: makeRegistry([makeTool()]),
    toolCtx: makeToolCtx(),
    permCtx: null,
    permHandler: null,
    denialTracker: null,
    hooks: [],
    sessionId: "test-session",
    tracer: new NoopTracer(),
    buildPermissionOpts: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockResolvePermission.mockReset();
});

describe("executeToolCall", () => {
  // --- Zod validation ---

  it("returns error on Zod validation failure without executing tool", async () => {
    const callSpy = vi.fn(async () => ({ content: "should not run" }));
    const failingSchema: ZodLikeSchema = {
      safeParse(): SafeParseResult {
        return {
          success: false,
          error: {
            issues: [
              { code: "invalid_type", path: ["command"], message: "Required" },
            ],
          },
        };
      },
    };
    const tool = makeTool({
      name: "StrictTool",
      inputSchema: failingSchema,
      call: callSpy,
    });
    const ctx = makeCtx({ registry: makeRegistry([tool]) });

    const result = await executeToolCall(
      makeTc("StrictTool"),
      { badField: 123 },
      ctx,
    );

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("StrictTool");
    expect(callSpy).not.toHaveBeenCalled();
  });

  // --- Permission deny ---

  it("returns permissionDenied and fires PermissionDenied hook on deny", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "deny",
      message: "Not allowed",
      reason: "rule",
    });

    const hookHandler = vi.fn();
    const hooks: HookDefinition[] = [
      { event: "PermissionDenied", handler: hookHandler },
    ];
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({ permCtx, hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.permissionDenied).toBe(true);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("Permission denied");
    expect(hookHandler).toHaveBeenCalledOnce();
    expect(result.events.some((e: StreamEvent) => e.type === "permission_denied")).toBe(true);
  });

  // --- Permission ask with no handler ---

  it("denies when permission is ask but no handler is configured", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "ask",
      message: "Needs approval",
    });

    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({ permCtx, permHandler: null });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.permissionDenied).toBe(true);
    expect(result.result.content).toContain("No permission handler configured");
  });

  // --- Permission ask with handler that denies ---

  it("denies when handler rejects and records denial", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "ask",
      message: "Please confirm",
    });

    const handler: PermissionHandler = async () => ({
      allow: false,
      feedback: "User said no",
    });
    const tracker = new DenialTracker();
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({
      permCtx,
      permHandler: handler,
      denialTracker: tracker,
    });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.permissionDenied).toBe(true);
    expect(result.result.content).toContain("User said no");
    expect(tracker.getState().consecutiveDenials).toBe(1);
  });

  // --- Permission ask with handler that approves + updatedInput ---

  it("uses updatedInput from permission handler", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "ask",
      message: "Confirm",
    });

    const callSpy = vi.fn(async (args: Record<string, unknown>) => ({
      content: `ran with ${args.command}`,
    }));
    const tool = makeTool({ call: callSpy });
    const handler: PermissionHandler = async () => ({
      allow: true,
      updatedInput: { command: "safe-command" },
    });
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({
      registry: makeRegistry([tool]),
      permCtx,
      permHandler: handler,
    });

    const result = await executeToolCall(
      makeTc("TestTool"),
      { command: "dangerous" },
      ctx,
    );

    expect(result.result.isError).toBeFalsy();
    expect(callSpy).toHaveBeenCalledWith(
      { command: "safe-command" },
      expect.anything(),
    );
  });

  // --- Hook deny ---

  it("returns permissionDenied: true when hook denies (documents conflation)", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        handler: async () => ({
          decision: "deny" as const,
          message: "Blocked by policy",
        }),
      },
    ];
    const ctx = makeCtx({ hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.permissionDenied).toBe(true);
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("Hook denied");
  });

  // --- Hook updatedInput outside working directories ---

  it("denies when hook-modified path is outside working directories", async () => {
    mockResolvePermission.mockResolvedValue({ behavior: "allow" });

    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        handler: async () => ({
          updatedInput: { file_path: "/etc/passwd" },
        }),
      },
    ];
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({ hooks, permCtx });

    const result = await executeToolCall(
      makeTc("TestTool"),
      { file_path: "/test/safe.txt" },
      ctx,
    );

    expect(result.permissionDenied).toBe(true);
    expect(result.result.content).toContain("outside working directories");
  });

  // --- Successful execution ---

  it("executes tool and returns result on success", async () => {
    const tool = makeTool({
      call: async () => ({ content: "hello world" }),
    });
    const ctx = makeCtx({ registry: makeRegistry([tool]) });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.content).toBe("hello world");
    expect(result.result.isError).toBeFalsy();
    expect(result.permissionDenied).toBeUndefined();
  });

  // --- PostToolUse hook updates output ---

  it("applies updatedOutput from PostToolUse hook", async () => {
    const tool = makeTool({
      call: async () => ({ content: "original output" }),
    });
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUse",
        handler: async () => ({
          updatedOutput: "modified output",
        }),
      },
    ];
    const ctx = makeCtx({ registry: makeRegistry([tool]), hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.content).toBe("modified output");
  });

  // --- PostToolUseFailure hook fires on error result ---

  it("fires PostToolUseFailure hook when tool returns error", async () => {
    const tool = makeTool({
      call: async () => ({ content: "something failed", isError: true }),
    });
    const failureHandler = vi.fn(async () => ({
      updatedOutput: "recovered output",
    }));
    const hooks: HookDefinition[] = [
      { event: "PostToolUse", handler: async () => ({}) },
      { event: "PostToolUseFailure", handler: failureHandler },
    ];
    const ctx = makeCtx({ registry: makeRegistry([tool]), hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(failureHandler).toHaveBeenCalledOnce();
    expect(result.result.content).toBe("recovered output");
  });

  // --- Catch block returns currentArgs not parsedArgs ---

  it("returns currentArgs (not original parsedArgs) when execution throws", async () => {
    const tool = makeTool({
      call: async () => { throw new Error("boom"); },
    });
    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        handler: async () => ({
          updatedInput: { modified: true },
        }),
      },
    ];
    const ctx = makeCtx({ registry: makeRegistry([tool]), hooks });

    const result = await executeToolCall(
      makeTc("TestTool"),
      { original: true },
      ctx,
    );

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("boom");
    expect(result.parsedArgs).toEqual({ modified: true });
    expect(result.parsedArgs).not.toHaveProperty("original");
  });

  // --- validateInput rejects ---

  it("returns error when validateInput rejects", async () => {
    const callSpy = vi.fn(async () => ({ content: "should not run" }));
    const tool = makeTool({
      name: "Validated",
      validateInput: async (args) => {
        if (!args.file_path) return "file_path is required";
        return undefined;
      },
      call: callSpy,
    });
    const ctx = makeCtx({ registry: makeRegistry([tool]) });

    const result = await executeToolCall(
      makeTc("Validated"),
      {},
      ctx,
    );

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("file_path is required");
    expect(callSpy).not.toHaveBeenCalled();
  });

  // --- Allow with updatedInput from resolvePermission ---

  it("uses updatedInput from resolvePermission allow decision", async () => {
    const callSpy = vi.fn(async (args: Record<string, unknown>) => ({
      content: `ran with ${args.command}`,
    }));
    const tool = makeTool({ call: callSpy });

    mockResolvePermission.mockResolvedValue({
      behavior: "allow",
      updatedInput: { command: "sanitized" },
    });

    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({
      registry: makeRegistry([tool]),
      permCtx,
    });

    const result = await executeToolCall(
      makeTc("TestTool"),
      { command: "dangerous" },
      ctx,
    );

    expect(result.result.isError).toBeFalsy();
    expect(callSpy).toHaveBeenCalledWith(
      { command: "sanitized" },
      expect.anything(),
    );
    expect(result.events.some((e: StreamEvent) => e.type === "permission_granted")).toBe(true);
  });

  // --- Classifier deny skips DenialTracker ---

  it("does not record denial for classifier reason", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "deny",
      message: "Classified as dangerous",
      reason: "classifier",
    });

    const tracker = new DenialTracker({ maxConsecutive: 10, maxTotal: 100 });
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({
      permCtx,
      denialTracker: tracker,
    });

    await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(tracker.getState().consecutiveDenials).toBe(0);
    expect(tracker.getState().totalDenials).toBe(0);
  });

  // --- Denial limit exceeded + preventContinuation ---

  it("emits denial_limit_exceeded and sets preventContinuation on threshold", async () => {
    mockResolvePermission.mockResolvedValue({
      behavior: "deny",
      message: "Not allowed",
      reason: "rule",
    });

    const tracker = new DenialTracker({ maxConsecutive: 2, maxTotal: 100 });
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/test"],
    };
    const ctx = makeCtx({
      permCtx,
      denialTracker: tracker,
    });

    // First denial — not yet at limit
    await executeToolCall(makeTc("TestTool", "tc_1"), {}, ctx);
    expect(tracker.getState().consecutiveDenials).toBe(1);

    // Second denial — hits the limit
    const result = await executeToolCall(makeTc("TestTool", "tc_2"), {}, ctx);

    expect(result.preventContinuation).toBe(true);
    const limitEvent = result.events.find((e: StreamEvent) => e.type === "denial_limit_exceeded");
    expect(limitEvent).toBeDefined();
  });

  // --- PreToolUse sets preventContinuation ---

  it("PreToolUse hook can set preventContinuation", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PreToolUse",
        handler: async () => ({
          preventContinuation: true,
        }),
      },
    ];
    const ctx = makeCtx({ hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.preventContinuation).toBe(true);
    expect(result.result.isError).toBeFalsy();
  });

  // --- PostToolUse sets preventContinuation ---

  it("PostToolUse hook can set preventContinuation", async () => {
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUse",
        handler: async () => ({
          preventContinuation: true,
        }),
      },
    ];
    const ctx = makeCtx({ hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.preventContinuation).toBe(true);
  });

  // --- PostToolUseFailure replaces output on caught error ---

  it("PostToolUseFailure hook replaces output when tool throws", async () => {
    const tool = makeTool({
      call: async () => { throw new Error("boom"); },
    });
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        handler: async () => ({
          updatedOutput: "gracefully handled error",
        }),
      },
    ];
    const ctx = makeCtx({ registry: makeRegistry([tool]), hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toBe("gracefully handled error");
  });

  // --- Hook throw in catch path is swallowed ---

  it("swallows PostToolUseFailure hook errors in catch path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = makeTool({
      call: async () => { throw new Error("original error"); },
    });
    const hooks: HookDefinition[] = [
      {
        event: "PostToolUseFailure",
        handler: async () => { throw new Error("hook explosion"); },
      },
    ];
    const ctx = makeCtx({ registry: makeRegistry([tool]), hooks });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("original error");
    expect(result.result.content).not.toContain("hook explosion");
  });

  it("truncates tool results exceeding maxResultChars", async () => {
    const largeTool = makeTool({
      call: async () => ({ content: "x".repeat(200_000) }),
    });
    const ctx = makeCtx({
      registry: makeRegistry([largeTool]),
      maxResultChars: 100_000,
    });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(typeof result.result.content === "string").toBe(true);
    const content = result.result.content as string;
    expect(content.length).toBeLessThan(200_000);
    expect(content).toContain("[Result truncated:");
  });

  it("does not truncate results under maxResultChars", async () => {
    const smallTool = makeTool({
      call: async () => ({ content: "short result" }),
    });
    const ctx = makeCtx({
      registry: makeRegistry([smallTool]),
      maxResultChars: 100_000,
    });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.content).toBe("short result");
  });

  it("does not truncate when maxResultChars is not set", async () => {
    const largeTool = makeTool({
      call: async () => ({ content: "x".repeat(200_000) }),
    });
    const ctx = makeCtx({ registry: makeRegistry([largeTool]) });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect((result.result.content as string).length).toBe(200_000);
  });

  it("aborts promptly when signal fires during permHandler", async () => {
    const ac = new AbortController();
    const tool = makeTool({ isReadOnly: false });

    mockResolvePermission.mockResolvedValue({
      behavior: "ask",
      message: "Confirm?",
    });

    const hangingHandler = (_req: import("../permissions/types.js").PermissionRequest) =>
      new Promise<import("../permissions/types.js").PermissionResponse>(() => {
        // Never resolves — simulates waiting for user input
      });

    const ctx = makeCtx({
      registry: makeRegistry([tool]),
      permCtx: { mode: "default", rules: [], workingDirectories: [] },
      permHandler: hangingHandler,
      toolCtx: { ...makeToolCtx(), signal: ac.signal },
    });

    setTimeout(() => ac.abort(), 50);

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("abort");
  });

  it("returns immediately when signal is already aborted before permHandler", async () => {
    const ac = new AbortController();
    ac.abort();

    const tool = makeTool({ isReadOnly: false });
    mockResolvePermission.mockResolvedValue({
      behavior: "ask",
      message: "Confirm?",
    });

    let handlerCalled = false;
    const ctx = makeCtx({
      registry: makeRegistry([tool]),
      permCtx: { mode: "default", rules: [], workingDirectories: [] },
      permHandler: async () => {
        handlerCalled = true;
        return { allow: true };
      },
      toolCtx: { ...makeToolCtx(), signal: ac.signal },
    });

    const result = await executeToolCall(makeTc("TestTool"), {}, ctx);

    expect(handlerCalled).toBe(false);
    expect(result.permissionDenied).toBe(true);
    expect(result.result.isError).toBe(true);
  });
});
