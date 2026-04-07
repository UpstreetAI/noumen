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
import type { PermissionConfig, PermissionContext } from "../permissions/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";
import {
  toolMatchesRule,
  contentMatchesRule,
  matchSimpleGlob,
  getMatchingRules,
  isPathInWorkingDirectories,
  containsShellExpansion,
} from "../permissions/rules.js";
import { resolvePermission, isDangerousPath } from "../permissions/pipeline.js";
import { DenialTracker } from "../permissions/denial-tracking.js";
import { resolveToolFlag } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { bashTool } from "../tools/bash.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import type { Tool, ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let fs: MockFs;
let computer: MockComputer;
let ctx: ToolContext;

beforeEach(() => {
  fs = new MockFs();
  computer = new MockComputer();
  ctx = { fs, computer, cwd: "/project" };
});

function makeContext(overrides?: Partial<PermissionContext>): PermissionContext {
  return {
    mode: "default",
    rules: [],
    workingDirectories: ["/project"],
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// =========================================================================
// Thread integration: permission gating
// =========================================================================

describe("Thread permission gating", () => {
  let provider: MockAIProvider;
  let baseConfig: ThreadConfig;

  beforeEach(() => {
    provider = new MockAIProvider();
    baseConfig = {
      provider: provider,
      fs,
      computer,
      sessionDir: "/sessions",
      autoCompact: createAutoCompactConfig({ enabled: false }),
    };
  });

  it("without permissions config, tools execute normally", async () => {
    fs.files.set("/project/hello.txt", "content");
    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/hello.txt" }),
    );
    provider.addResponse(textResponse("Done"));

    const thread = new Thread(baseConfig, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("read file"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
    const permDenied = events.filter((e) => e.type === "permission_denied");
    expect(permDenied).toHaveLength(0);
  });

  it("denies tools blocked by deny rule", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "rm -rf /" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        rules: [{ toolName: "Bash", behavior: "deny" }],
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("delete everything"));

    const denied = events.filter((e) => e.type === "permission_denied");
    expect(denied).toHaveLength(1);
    if (denied[0]?.type === "permission_denied") {
      expect(denied[0].toolName).toBe("Bash");
    }
    // Tool should NOT have been executed
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(0);
  });

  it("allows read-only tools in default mode", async () => {
    fs.files.set("/project/hello.txt", "hello");
    provider.addResponse(
      toolCallResponse("tc1", "ReadFile", { file_path: "/project/hello.txt" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        workingDirectories: ["/project"],
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("read hello"));

    const granted = events.filter((e) => e.type === "permission_granted");
    expect(granted).toHaveLength(1);

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
  });

  it("asks handler for write tools in default mode, handler approves", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "WriteFile", {
        file_path: "/project/out.txt",
        content: "data",
      }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        handler: async () => ({ allow: true }),
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("write file"));

    const requests = events.filter((e) => e.type === "permission_request");
    expect(requests).toHaveLength(1);

    const granted = events.filter((e) => e.type === "permission_granted");
    expect(granted).toHaveLength(1);

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
  });

  it("asks handler, handler denies", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "dangerous" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        handler: async () => ({
          allow: false,
          feedback: "Not allowed by policy",
        }),
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("do something"));

    const denied = events.filter((e) => e.type === "permission_denied");
    expect(denied).toHaveLength(1);
    if (denied[0]?.type === "permission_denied") {
      expect(denied[0].message).toBe("Not allowed by policy");
    }
  });

  it("no handler + ask = fail-closed deny", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "npm install" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        // no handler
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("run echo"));

    const denied = events.filter((e) => e.type === "permission_denied");
    expect(denied).toHaveLength(1);
    if (denied[0]?.type === "permission_denied") {
      expect(denied[0].message).toContain("No permission handler");
    }
  });

  it("handler can add rules that persist across tool calls", async () => {
    // First call: Bash with npm install → handler approves and adds allow rule
    // Second call: Bash with npm install again → should be auto-allowed by rule
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "npm install" }),
    );
    provider.addResponse(
      toolCallResponse("tc2", "Bash", { command: "npm install" }),
    );
    provider.addResponse(textResponse("Done"));

    let handlerCalls = 0;
    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        handler: async () => {
          handlerCalls++;
          return {
            allow: true,
            addRules: [
              { toolName: "Bash", behavior: "allow" as const, ruleContent: "npm install" },
            ],
          };
        },
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("run install twice"));

    // Handler should only have been called once; second call auto-allowed by rule
    expect(handlerCalls).toBe(1);

    const granted = events.filter((e) => e.type === "permission_granted");
    expect(granted).toHaveLength(2);
  });

  it("handler can modify input via updatedInput", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "dangerous-cmd" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "default",
        handler: async () => ({
          allow: true,
          updatedInput: { command: "safe-cmd" },
        }),
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("run something"));

    const granted = events.filter((e) => e.type === "permission_granted");
    expect(granted).toHaveLength(1);
    if (granted[0]?.type === "permission_granted") {
      expect(granted[0].input).toEqual({ command: "safe-cmd" });
    }
  });

  it("bypassPermissions mode skips all checks", async () => {
    provider.addResponse(
      toolCallResponse("tc1", "Bash", { command: "rm -rf /" }),
    );
    provider.addResponse(textResponse("Done"));

    const config: ThreadConfig = {
      ...baseConfig,
      permissions: {
        mode: "bypassPermissions",
      },
    };

    const thread = new Thread(config, { sessionId: "s1", cwd: "/project" });
    const events = await collectEvents(thread.run("yolo"));

    const denied = events.filter((e) => e.type === "permission_denied");
    expect(denied).toHaveLength(0);

    const granted = events.filter((e) => e.type === "permission_granted");
    expect(granted).toHaveLength(1);
  });
});

// =========================================================================
// auto mode classifier denial returns deny
// =========================================================================

describe("auto mode classifier denial returns deny", () => {
  it("returns deny (not ask) when classifier flags the call", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "echo test" },
      ctx,
      makeContext({ mode: "auto" }),
      {
        autoModeConfig: {
          classifierModel: "mock",
        },
        provider: {
          async *chat() {
            yield {
              id: "c",
              model: "mock",
              choices: [{ index: 0, delta: { content: '{"shouldBlock":true,"reason":"dangerous"}' }, finish_reason: null }],
            };
            yield {
              id: "c",
              model: "mock",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
          },
        },
        model: "mock",
        recentMessages: [],
      },
    );

    expect(result.behavior).toBe("deny");
    expect(result.reason).toBe("classifier");
  });
});

// ---------------------------------------------------------------------------
// checkPermissions error handling — pipeline should not crash
// ---------------------------------------------------------------------------
describe("checkPermissions error does not crash pipeline", () => {
  it("falls through when checkPermissions throws a non-abort error", async () => {
    const tool: Tool = {
      name: "BrokenTool",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions() {
        throw new Error("Unexpected failure in checkPermissions");
      },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "default" });
    const decision = await resolvePermission(tool, {}, ctx, permCtx);
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("default");
  });

  it("still throws on AbortError", async () => {
    const tool: Tool = {
      name: "AbortTool",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions() {
        throw new DOMException("Aborted", "AbortError");
      },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "default" });
    await expect(resolvePermission(tool, {}, ctx, permCtx)).rejects.toThrow("Aborted");
  });
});

// ---------------------------------------------------------------------------
// Allow rules cannot bypass working directory enforcement
// ---------------------------------------------------------------------------
describe("allow rule does not bypass working directory", () => {
  it("asks when path is outside working directories even with allow rule", async () => {
    const tool: Tool = {
      name: "WriteFile",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({
      mode: "default",
      rules: [
        { toolName: "WriteFile", behavior: "allow" as const },
      ],
      workingDirectories: ["/project"],
    });
    const decision = await resolvePermission(
      tool,
      { file_path: "/etc/passwd" },
      ctx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("workingDirectory");
  });
});

// ---------------------------------------------------------------------------
// Interactive tools cannot be auto-approved in auto mode
// ---------------------------------------------------------------------------
describe("interactive tool guard in auto mode", () => {
  it("asks for interactive tool even when classifier approves", async () => {
    const provider = new MockAIProvider([
      textResponse(JSON.stringify({ shouldBlock: false, reason: "approved" })),
    ]);
    const tool: Tool = {
      name: "AskUser",
      description: "test",
      parameters: { type: "object", properties: {} },
      requiresUserInteraction: true,
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "auto" });
    const decision = await resolvePermission(tool, {}, ctx, permCtx, {
      provider,
      model: "test-model",
      autoModeConfig: { classifierPrompt: "test" },
    });
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("interaction");
  });
});

// ---------------------------------------------------------------------------
// Bug 7: Read-only tools must respect checkPermissions ask
// ---------------------------------------------------------------------------
describe("read-only tool checkPermissions ask override", () => {
  it("does not auto-allow a read-only tool whose checkPermissions returns ask", async () => {
    const tool: Tool = {
      name: "WebFetch",
      description: "test",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      async checkPermissions() {
        return { behavior: "ask", message: "Confirm URL before fetching." };
      },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "default" });
    const decision = await resolvePermission(tool, { url: "https://evil.com" }, ctx, permCtx);
    expect(decision.behavior).toBe("ask");
  });

  it("auto-allows a read-only tool whose checkPermissions returns allow", async () => {
    const tool: Tool = {
      name: "ReadFile",
      description: "test",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      async checkPermissions() {
        return { behavior: "allow" };
      },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "default" });
    const decision = await resolvePermission(tool, { file_path: "/project/a.txt" }, ctx, permCtx);
    expect(decision.behavior).toBe("allow");
  });

  it("auto-allows a read-only tool with no checkPermissions", async () => {
    const tool: Tool = {
      name: "Glob",
      description: "test",
      parameters: { type: "object", properties: {} },
      isReadOnly: true,
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "default" });
    const decision = await resolvePermission(tool, {}, ctx, permCtx);
    expect(decision.behavior).toBe("allow");
    expect(decision.reason).toBe("readOnly");
  });
});

// ---------------------------------------------------------------------------
// Bug 9: Interactive tool in auto mode must not reset denial tracker
// ---------------------------------------------------------------------------
describe("auto mode denial tracker with interactive tools", () => {
  it("does not reset consecutive denials when interactive tool is asked", async () => {
    const provider = new MockAIProvider([
      textResponse(JSON.stringify({ shouldBlock: false, reason: "approved" })),
    ]);
    const denialTracker = new DenialTracker({ maxConsecutive: 3, maxTotal: 20 });

    denialTracker.recordDenial();
    denialTracker.recordDenial();
    expect(denialTracker.getState().consecutiveDenials).toBe(2);

    const tool: Tool = {
      name: "AskUser",
      description: "test",
      parameters: { type: "object", properties: {} },
      requiresUserInteraction: true,
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "auto" });
    await resolvePermission(tool, {}, ctx, permCtx, {
      provider,
      model: "test-model",
      autoModeConfig: { classifierPrompt: "test" },
      denialTracker,
    });

    expect(denialTracker.getState().consecutiveDenials).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bug 10: Bash command targeting dangerous paths must be caught
// ---------------------------------------------------------------------------
describe("bash command dangerous path check", () => {
  it("asks when bash command targets .git/", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "bypassPermissions" });
    const decision = await resolvePermission(
      tool,
      { command: "echo x > .git/config" },
      ctx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("safetyCheck");
  });

  it("asks when bash command targets .ssh/", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "bypassPermissions" });
    const decision = await resolvePermission(
      tool,
      { command: "cat .ssh/id_rsa" },
      ctx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("safetyCheck");
  });

  it("allows bash command with no dangerous paths", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "bypassPermissions" });
    const decision = await resolvePermission(
      tool,
      { command: "ls -la /project" },
      ctx,
      permCtx,
    );
    expect(decision.behavior).toBe("allow");
  });

  it("asks when bash compound command includes dangerous path", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() {
        return { content: "ok" };
      },
    };
    const permCtx = makeContext({ mode: "bypassPermissions" });
    const decision = await resolvePermission(
      tool,
      { command: "echo hello && cat .env" },
      ctx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("safetyCheck");
  });
});
