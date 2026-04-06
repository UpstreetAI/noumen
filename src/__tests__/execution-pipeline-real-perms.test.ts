/**
 * Integration tests for executeToolCall with the REAL resolvePermission pipeline.
 * Unlike execution-pipeline.test.ts, this file does NOT mock resolvePermission,
 * so it exercises the full mode matrix, dangerous path checks, and tool
 * checkPermissions interaction.
 */
import { describe, it, expect } from "vitest";
import { executeToolCall, type ToolExecutionContext } from "../tools/execution-pipeline.js";
import type { ToolCallContent, StreamEvent } from "../session/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import type { PermissionContext, PermissionResult, PermissionMode } from "../permissions/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { DenialTracker } from "../permissions/denial-tracking.js";
import { NoopTracer } from "../tracing/noop.js";
import { MockFs, MockComputer } from "./helpers.js";

function makeTc(name: string, args: Record<string, unknown> = {}, id = "tc_1"): ToolCallContent {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeReadTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "ReadFile",
    description: "Read a file",
    parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    call: async (args) => ({ content: `contents of ${args.file_path}` }),
    ...overrides,
  };
}

function makeWriteTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "WriteFile",
    description: "Write a file",
    parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] },
    isReadOnly: false,
    isConcurrencySafe: false,
    call: async (args) => ({ content: `wrote to ${args.file_path}` }),
    ...overrides,
  };
}

function makeBashTool(overrides?: Partial<Tool>): Tool {
  return {
    name: "Bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    isReadOnly: (input) => {
      const cmd = String(input.command ?? "");
      return /^\s*(ls|cat|echo|pwd|head|tail|wc|grep|find|which|type|file)\b/.test(cmd);
    },
    isDestructive: (input) => {
      const cmd = String(input.command ?? "");
      return /\b(rm|rmdir|dd|mkfs|format)\b/.test(cmd);
    },
    isConcurrencySafe: true,
    call: async (args) => ({ content: `ran: ${args.command}` }),
    ...overrides,
  };
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const reg = new ToolRegistry([]);
  for (const t of tools) reg.register(t);
  return reg;
}

function makeToolCtx(cwd = "/project"): ToolContext {
  return {
    fs: new MockFs(),
    computer: new MockComputer(),
    cwd,
  };
}

function makeCtx(
  tools: Tool[],
  permCtx: PermissionContext | null,
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  return {
    registry: makeRegistry(tools),
    toolCtx: makeToolCtx(),
    permCtx,
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
// Mode matrix tests
// ---------------------------------------------------------------------------

describe("executeToolCall with real resolvePermission", () => {
  describe("plan mode", () => {
    const permCtx: PermissionContext = {
      mode: "plan",
      rules: [],
      workingDirectories: ["/project"],
    };

    it("allows read-only tools", async () => {
      const readTool = makeReadTool();
      const ctx = makeCtx([readTool], permCtx);
      const result = await executeToolCall(
        makeTc("ReadFile", { file_path: "/project/a.txt" }),
        { file_path: "/project/a.txt" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
      expect(result.result.content).toContain("contents of");
    });

    it("denies write tools", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/b.txt", content: "x" }),
        { file_path: "/project/b.txt", content: "x" },
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
      expect(result.result.isError).toBe(true);
    });

    it("allows read-only bash commands", async () => {
      const bashTool = makeBashTool();
      const ctx = makeCtx([bashTool], permCtx);
      const result = await executeToolCall(
        makeTc("Bash", { command: "ls /project" }),
        { command: "ls /project" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("denies mutating bash commands", async () => {
      const bashTool = makeBashTool();
      const ctx = makeCtx([bashTool], permCtx);
      const result = await executeToolCall(
        makeTc("Bash", { command: "npm install foo" }),
        { command: "npm install foo" },
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
    });
  });

  describe("bypassPermissions mode", () => {
    const permCtx: PermissionContext = {
      mode: "bypassPermissions",
      rules: [],
      workingDirectories: ["/project"],
    };

    it("allows read tools", async () => {
      const readTool = makeReadTool();
      const ctx = makeCtx([readTool], permCtx);
      const result = await executeToolCall(
        makeTc("ReadFile", { file_path: "/project/a.txt" }),
        { file_path: "/project/a.txt" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("allows write tools", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/b.txt", content: "x" }),
        { file_path: "/project/b.txt", content: "x" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("still prompts for dangerous paths (bypass-immune)", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/.env", content: "SECRET=x" }),
        { file_path: "/project/.env", content: "SECRET=x" },
        ctx,
      );
      // Dangerous path check is bypass-immune — resolvePermission returns "ask",
      // which without a handler becomes a permission denial
      expect(result.permissionDenied).toBe(true);
      expect(result.result.isError).toBe(true);
    });
  });

  describe("dontAsk mode", () => {
    const permCtx: PermissionContext = {
      mode: "dontAsk",
      rules: [],
      workingDirectories: ["/project"],
    };

    it("allows read-only tools", async () => {
      const readTool = makeReadTool();
      const ctx = makeCtx([readTool], permCtx);
      const result = await executeToolCall(
        makeTc("ReadFile", { file_path: "/project/a.txt" }),
        { file_path: "/project/a.txt" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("denies write tools (would normally ask, but dontAsk converts to deny)", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/b.txt", content: "x" }),
        { file_path: "/project/b.txt", content: "x" },
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
      expect(result.result.content).toContain("dontAsk");
    });
  });

  describe("acceptEdits mode", () => {
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };

    it("allows write tools within working directories", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/b.txt", content: "x" }),
        { file_path: "/project/b.txt", content: "x" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("prompts for bash commands not in allowlist", async () => {
      const bashTool = makeBashTool();
      const ctx = makeCtx([bashTool], permCtx);
      const result = await executeToolCall(
        makeTc("Bash", { command: "npm install foo" }),
        { command: "npm install foo" },
        ctx,
      );
      // "npm" is not in ACCEPT_EDITS_BASH_ALLOWLIST → ask → no handler → deny
      expect(result.permissionDenied).toBe(true);
    });

    it("allows allowlisted bash commands", async () => {
      const bashTool = makeBashTool();
      const ctx = makeCtx([bashTool], permCtx);
      const result = await executeToolCall(
        makeTc("Bash", { command: "mkdir /project/newdir" }),
        { command: "mkdir /project/newdir" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("prompts for destructive bash commands", async () => {
      const bashTool = makeBashTool();
      const ctx = makeCtx([bashTool], permCtx);
      const result = await executeToolCall(
        makeTc("Bash", { command: "rm -rf /project/dir" }),
        { command: "rm -rf /project/dir" },
        ctx,
      );
      // "rm" is destructive → ask → no handler → deny
      expect(result.permissionDenied).toBe(true);
    });
  });

  describe("default mode", () => {
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: ["/project"],
    };

    it("allows read-only tools", async () => {
      const readTool = makeReadTool();
      const ctx = makeCtx([readTool], permCtx);
      const result = await executeToolCall(
        makeTc("ReadFile", { file_path: "/project/a.txt" }),
        { file_path: "/project/a.txt" },
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
    });

    it("falls back to ask→deny for write tools without handler", async () => {
      const writeTool = makeWriteTool();
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/b.txt", content: "x" }),
        { file_path: "/project/b.txt", content: "x" },
        ctx,
      );
      // Default mode → write tool → passthrough→ask → no handler → deny
      expect(result.permissionDenied).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Dangerous path + bypassPermissions
  // ---------------------------------------------------------------------------

  describe("dangerous paths are bypass-immune", () => {
    it(".git paths trigger ask in bypassPermissions mode", async () => {
      const writeTool = makeWriteTool();
      const permCtx: PermissionContext = {
        mode: "bypassPermissions",
        rules: [],
        workingDirectories: ["/project"],
      };
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/.git/config", content: "x" }),
        { file_path: "/project/.git/config", content: "x" },
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
      expect(result.result.isError).toBe(true);
    });

    it(".ssh paths trigger ask in bypassPermissions mode", async () => {
      const writeTool = makeWriteTool();
      const permCtx: PermissionContext = {
        mode: "bypassPermissions",
        rules: [],
        workingDirectories: ["/project"],
      };
      const ctx = makeCtx([writeTool], permCtx);
      const result = await executeToolCall(
        makeTc("WriteFile", { file_path: "/project/.ssh/authorized_keys", content: "x" }),
        { file_path: "/project/.ssh/authorized_keys", content: "x" },
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool checkPermissions + mode interaction
  // ---------------------------------------------------------------------------

  describe("tool checkPermissions + mode interaction", () => {
    it("tool returns ask, plan mode denies", async () => {
      const askingTool: Tool = {
        name: "CustomTool",
        description: "tool with checkPermissions",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        call: async () => ({ content: "executed" }),
        checkPermissions: async () => ({
          behavior: "ask" as const,
          message: "This tool needs approval",
        }),
      };
      const permCtx: PermissionContext = {
        mode: "plan",
        rules: [],
        workingDirectories: ["/project"],
      };
      const ctx = makeCtx([askingTool], permCtx);
      const result = await executeToolCall(
        makeTc("CustomTool"),
        {},
        ctx,
      );
      // plan mode denies non-read-only tools
      expect(result.permissionDenied).toBe(true);
    });

    it("tool returns allow, default mode respects it", async () => {
      const allowingTool: Tool = {
        name: "CustomTool",
        description: "tool with checkPermissions",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        call: async () => ({ content: "executed" }),
        checkPermissions: async () => ({
          behavior: "allow" as const,
          message: "Pre-approved",
        }),
      };
      const permCtx: PermissionContext = {
        mode: "default",
        rules: [],
        workingDirectories: ["/project"],
      };
      const ctx = makeCtx([allowingTool], permCtx);
      const result = await executeToolCall(
        makeTc("CustomTool"),
        {},
        ctx,
      );
      expect(result.result.isError).toBeFalsy();
      expect(result.result.content).toBe("executed");
    });

    it("deny rule overrides tool's allow", async () => {
      const allowingTool: Tool = {
        name: "CustomTool",
        description: "tool with checkPermissions",
        parameters: { type: "object", properties: {} },
        isReadOnly: false,
        call: async () => ({ content: "should not run" }),
        checkPermissions: async () => ({
          behavior: "allow" as const,
          message: "Pre-approved",
        }),
      };
      const permCtx: PermissionContext = {
        mode: "default",
        rules: [{ toolName: "CustomTool", behavior: "deny" }],
        workingDirectories: ["/project"],
      };
      const ctx = makeCtx([allowingTool], permCtx);
      const result = await executeToolCall(
        makeTc("CustomTool"),
        {},
        ctx,
      );
      expect(result.permissionDenied).toBe(true);
      expect(result.result.isError).toBe(true);
    });
  });
});
