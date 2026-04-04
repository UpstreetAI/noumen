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
} from "../permissions/rules.js";
import { resolvePermission } from "../permissions/pipeline.js";
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
// resolveToolFlag
// =========================================================================

describe("resolveToolFlag", () => {
  it("returns default when flag is undefined", () => {
    expect(resolveToolFlag(undefined, {})).toBe(false);
    expect(resolveToolFlag(undefined, {}, true)).toBe(true);
  });

  it("returns static boolean", () => {
    expect(resolveToolFlag(true, {})).toBe(true);
    expect(resolveToolFlag(false, {})).toBe(false);
  });

  it("calls function with args", () => {
    const fn = (args: Record<string, unknown>) => args.safe === true;
    expect(resolveToolFlag(fn, { safe: true })).toBe(true);
    expect(resolveToolFlag(fn, { safe: false })).toBe(false);
  });
});

// =========================================================================
// Built-in tool metadata
// =========================================================================

describe("built-in tool permission metadata", () => {
  it("ReadFile is read-only", () => {
    expect(readFileTool.isReadOnly).toBe(true);
  });

  it("Glob is read-only", () => {
    expect(globTool.isReadOnly).toBe(true);
  });

  it("Grep is read-only", () => {
    expect(grepTool.isReadOnly).toBe(true);
  });

  it("WriteFile is not read-only and has checkPermissions", () => {
    expect(writeFileTool.isReadOnly).toBe(false);
    expect(writeFileTool.checkPermissions).toBeDefined();
  });

  it("EditFile is not read-only and has checkPermissions", () => {
    expect(editFileTool.isReadOnly).toBe(false);
    expect(editFileTool.checkPermissions).toBeDefined();
  });

  it("Bash has checkPermissions", () => {
    expect(bashTool.checkPermissions).toBeDefined();
  });

  it("WriteFile.checkPermissions returns passthrough with file path", () => {
    const result = writeFileTool.checkPermissions!(
      { file_path: "/foo/bar.ts" },
      ctx,
    );
    expect(result).toMatchObject({
      behavior: "passthrough",
      message: "Write to /foo/bar.ts",
    });
  });

  it("Bash.checkPermissions returns ask for destructive commands", () => {
    const result = bashTool.checkPermissions!(
      { command: "rm -rf /" },
      ctx,
    );
    expect(result).toMatchObject({
      behavior: "ask",
    });
    expect((result as { message: string }).message).toContain("Destructive");
  });

  it("Bash.checkPermissions returns passthrough for safe commands", () => {
    const result = bashTool.checkPermissions!(
      { command: "ls -la" },
      ctx,
    );
    expect(result).toMatchObject({
      behavior: "passthrough",
      message: "Execute: ls -la",
    });
  });
});

// =========================================================================
// Rule matching
// =========================================================================

describe("toolMatchesRule", () => {
  it("matches exact tool name", () => {
    expect(
      toolMatchesRule("Bash", { toolName: "Bash", behavior: "deny" }),
    ).toBe(true);
  });

  it("does not match different name", () => {
    expect(
      toolMatchesRule("ReadFile", { toolName: "Bash", behavior: "deny" }),
    ).toBe(false);
  });

  it("matches MCP server-level rule", () => {
    expect(
      toolMatchesRule(
        "mcp__github__create_issue",
        { toolName: "mcp__github", behavior: "deny" },
        { serverName: "github", toolName: "create_issue" },
      ),
    ).toBe(true);
  });

  it("does not match MCP server-level rule for different server", () => {
    expect(
      toolMatchesRule(
        "mcp__gitlab__create_issue",
        { toolName: "mcp__github", behavior: "deny" },
        { serverName: "gitlab", toolName: "create_issue" },
      ),
    ).toBe(false);
  });
});

describe("contentMatchesRule", () => {
  it("matches exact content", () => {
    expect(contentMatchesRule("npm test", "npm test")).toBe(true);
  });

  it("does not match different content", () => {
    expect(contentMatchesRule("npm run build", "npm test")).toBe(false);
  });

  it("matches prefix rule with :*", () => {
    expect(contentMatchesRule("npm test", "npm:*")).toBe(true);
    expect(contentMatchesRule("npm run build", "npm:*")).toBe(true);
  });

  it("prefix rule matches exact prefix without args", () => {
    expect(contentMatchesRule("npm", "npm:*")).toBe(true);
  });

  it("prefix rule does not match partial prefix", () => {
    expect(contentMatchesRule("npmx test", "npm:*")).toBe(false);
  });
});

describe("matchSimpleGlob", () => {
  it("matches single * for non-separator chars", () => {
    expect(matchSimpleGlob("/src/*.ts", "/src/index.ts")).toBe(true);
    expect(matchSimpleGlob("/src/*.ts", "/src/deep/index.ts")).toBe(false);
  });

  it("matches ** for any depth", () => {
    expect(matchSimpleGlob("/src/**/*.ts", "/src/deep/index.ts")).toBe(true);
    expect(matchSimpleGlob("/src/**/*.ts", "/src/a/b/c.ts")).toBe(true);
  });

  it("matches ? for single non-separator char", () => {
    expect(matchSimpleGlob("/src/?.ts", "/src/a.ts")).toBe(true);
    expect(matchSimpleGlob("/src/?.ts", "/src/ab.ts")).toBe(false);
  });

  it("exact string without wildcards", () => {
    expect(matchSimpleGlob("/src/index.ts", "/src/index.ts")).toBe(true);
    expect(matchSimpleGlob("/src/index.ts", "/src/other.ts")).toBe(false);
  });
});

describe("getMatchingRules", () => {
  it("filters by behavior and tool name", () => {
    const permCtx = makeContext({
      rules: [
        { toolName: "Bash", behavior: "deny" },
        { toolName: "Bash", behavior: "allow", ruleContent: "npm test" },
        { toolName: "WriteFile", behavior: "deny" },
      ],
    });

    const denyRules = getMatchingRules(permCtx, "Bash", "deny");
    expect(denyRules).toHaveLength(1);

    const allowRules = getMatchingRules(permCtx, "Bash", "allow", "npm test");
    expect(allowRules).toHaveLength(1);
  });

  it("whole-tool rules match even when content is provided", () => {
    const permCtx = makeContext({
      rules: [{ toolName: "Bash", behavior: "deny" }],
    });
    const rules = getMatchingRules(permCtx, "Bash", "deny", "any command");
    expect(rules).toHaveLength(1);
  });

  it("content-specific rules only match when content matches", () => {
    const permCtx = makeContext({
      rules: [{ toolName: "Bash", behavior: "allow", ruleContent: "npm test" }],
    });
    expect(getMatchingRules(permCtx, "Bash", "allow", "npm test")).toHaveLength(1);
    expect(getMatchingRules(permCtx, "Bash", "allow", "rm -rf /")).toHaveLength(0);
  });
});

describe("isPathInWorkingDirectories", () => {
  it("returns true for files inside working dirs", () => {
    expect(isPathInWorkingDirectories("/project/src/a.ts", ["/project"])).toBe(true);
  });

  it("returns true for the working dir itself", () => {
    expect(isPathInWorkingDirectories("/project", ["/project"])).toBe(true);
  });

  it("returns false for files outside working dirs", () => {
    expect(isPathInWorkingDirectories("/etc/passwd", ["/project"])).toBe(false);
  });

  it("handles trailing slashes", () => {
    expect(isPathInWorkingDirectories("/project/a.ts", ["/project/"])).toBe(true);
  });

  it("returns false when no working directories", () => {
    expect(isPathInWorkingDirectories("/project/a.ts", [])).toBe(false);
  });
});

// =========================================================================
// Permission pipeline
// =========================================================================

describe("resolvePermission", () => {
  it("allows read-only tools in default mode", async () => {
    const result = await resolvePermission(
      readFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext(),
    );
    expect(result.behavior).toBe("allow");
  });

  it("asks for write tools in default mode (no allow rules)", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext(),
    );
    expect(result.behavior).toBe("ask");
  });

  it("denies tools matched by deny rule", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "rm -rf /" },
      ctx,
      makeContext({ rules: [{ toolName: "Bash", behavior: "deny" }] }),
    );
    expect(result.behavior).toBe("deny");
  });

  it("content-specific deny rule blocks matching command", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "rm -rf /" },
      ctx,
      makeContext({
        rules: [{ toolName: "Bash", behavior: "deny", ruleContent: "rm -rf /" }],
      }),
    );
    expect(result.behavior).toBe("deny");
  });

  it("content-specific deny rule does not block non-matching command", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "npm install" },
      ctx,
      makeContext({
        rules: [{ toolName: "Bash", behavior: "deny", ruleContent: "rm -rf /" }],
      }),
    );
    // No deny match, falls through to ask (no allow rules for Bash)
    expect(result.behavior).toBe("ask");
  });

  it("allows tools matched by allow rule", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "npm test" },
      ctx,
      makeContext({
        rules: [{ toolName: "Bash", behavior: "allow", ruleContent: "npm test" }],
      }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("allows tools matched by whole-tool allow rule", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: "/anywhere/file.ts" },
      ctx,
      makeContext({
        rules: [{ toolName: "WriteFile", behavior: "allow" }],
      }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("prefix allow rule works for bash commands", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "npm run build" },
      ctx,
      makeContext({
        rules: [{ toolName: "Bash", behavior: "allow", ruleContent: "npm:*" }],
      }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("glob allow rule works for file paths", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: "/src/components/Button.tsx" },
      ctx,
      makeContext({
        rules: [
          { toolName: "WriteFile", behavior: "allow", ruleContent: "/src/**/*.tsx" },
        ],
      }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("bypassPermissions mode allows everything", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "rm -rf /" },
      ctx,
      makeContext({ mode: "bypassPermissions" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("plan mode denies non-read-only tools", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext({ mode: "plan" }),
    );
    expect(result.behavior).toBe("deny");
  });

  it("plan mode allows read-only tools", async () => {
    const result = await resolvePermission(
      readFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext({ mode: "plan" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("dontAsk mode denies tools that would prompt", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "npm install" },
      ctx,
      makeContext({ mode: "dontAsk" }),
    );
    expect(result.behavior).toBe("deny");
  });

  it("dontAsk mode still allows read-only tools", async () => {
    const result = await resolvePermission(
      readFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext({ mode: "dontAsk" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("deny rules take precedence over allow rules", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "npm test" },
      ctx,
      makeContext({
        rules: [
          { toolName: "Bash", behavior: "deny" },
          { toolName: "Bash", behavior: "allow", ruleContent: "npm test" },
        ],
      }),
    );
    expect(result.behavior).toBe("deny");
  });

  it("ask rules for whole tool take effect", async () => {
    const result = await resolvePermission(
      readFileTool,
      { file_path: "/project/a.ts" },
      ctx,
      makeContext({
        rules: [{ toolName: "ReadFile", behavior: "ask" }],
      }),
    );
    expect(result.behavior).toBe("ask");
  });

  it("tool with custom checkPermissions returning deny is honored", async () => {
    const customTool: Tool = {
      name: "Dangerous",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions: () => ({
        behavior: "deny" as const,
        message: "Always blocked",
      }),
      async call() {
        return { content: "ok" };
      },
    };

    const result = await resolvePermission(
      customTool,
      {},
      ctx,
      makeContext(),
    );
    expect(result.behavior).toBe("deny");
    expect(result).toHaveProperty("message", "Always blocked");
  });

  it("tool with custom checkPermissions returning allow is honored", async () => {
    const customTool: Tool = {
      name: "Safe",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions: (args) => ({
        behavior: "allow" as const,
        updatedInput: args,
      }),
      async call() {
        return { content: "ok" };
      },
    };

    const result = await resolvePermission(
      customTool,
      { x: 1 },
      ctx,
      makeContext(),
    );
    expect(result.behavior).toBe("allow");
  });
});

// =========================================================================
// Thread integration: permission gating
// =========================================================================

describe("Thread permission gating", () => {
  let provider: MockAIProvider;
  let baseConfig: ThreadConfig;

  beforeEach(() => {
    provider = new MockAIProvider();
    baseConfig = {
      aiProvider: provider,
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
