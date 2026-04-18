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
import { stripForRuleMatching } from "../permissions/rules.js";

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
      { file_path: "/project/file.ts" },
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
      { file_path: "/project/src/components/Button.tsx" },
      ctx,
      makeContext({
        rules: [
          { toolName: "WriteFile", behavior: "allow", ruleContent: "/project/src/**/*.tsx" },
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

  it("dontAsk mode denies tools whose checkPermissions returns passthrough", async () => {
    const passthroughTool: Tool = {
      name: "WriteTool",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions: () => ({
        behavior: "passthrough" as const,
        message: "Write to /project/file.ts",
      }),
      async call() { return { content: "ok" }; },
    };

    const result = await resolvePermission(
      passthroughTool,
      { file_path: "/project/file.ts" },
      ctx,
      makeContext({ mode: "dontAsk" }),
    );
    expect(result.behavior).toBe("deny");
    expect(result.reason).toBe("mode");
  });

  it("dontAsk mode denies tools whose checkPermissions returns ask", async () => {
    const askTool: Tool = {
      name: "DangerTool",
      description: "test",
      parameters: { type: "object", properties: {} },
      checkPermissions: () => ({
        behavior: "ask" as const,
        message: "Confirm this action",
      }),
      async call() { return { content: "ok" }; },
    };

    const result = await resolvePermission(
      askTool,
      {},
      ctx,
      makeContext({ mode: "dontAsk" }),
    );
    expect(result.behavior).toBe("deny");
    expect(result.reason).toBe("mode");
  });

  it("dontAsk mode denies tools with no checkPermissions (default fallback)", async () => {
    const genericTool: Tool = {
      name: "GenericTool",
      description: "test",
      parameters: { type: "object", properties: {} },
      async call() { return { content: "ok" }; },
    };

    const result = await resolvePermission(
      genericTool,
      {},
      ctx,
      makeContext({ mode: "dontAsk" }),
    );
    expect(result.behavior).toBe("deny");
    expect(result.reason).toBe("mode");
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
// isDangerousPath
// =========================================================================

describe("isDangerousPath", () => {
  it("detects .git/HEAD case-insensitively", () => {
    expect(isDangerousPath(".git/HEAD")).toBe(true);
    expect(isDangerousPath(".git/head")).toBe(true);
  });

  it("detects .ssh directory", () => {
    expect(isDangerousPath(".ssh/id_rsa")).toBe(true);
    expect(isDangerousPath(".ssh/config")).toBe(true);
  });

  it("detects .env files", () => {
    expect(isDangerousPath(".env")).toBe(true);
    expect(isDangerousPath("subdir/.env")).toBe(true);
  });

  it("detects newly added patterns (.vscode, .idea, .claude, .gitconfig, .mcp.json)", () => {
    expect(isDangerousPath(".vscode/settings.json")).toBe(true);
    expect(isDangerousPath(".idea/workspace.xml")).toBe(true);
    expect(isDangerousPath(".claude/config")).toBe(true);
    expect(isDangerousPath(".gitconfig")).toBe(true);
    expect(isDangerousPath(".gitmodules")).toBe(true);
    expect(isDangerousPath(".mcp.json")).toBe(true);
  });

  it("does not flag safe paths", () => {
    expect(isDangerousPath("src/index.ts")).toBe(false);
    expect(isDangerousPath("README.md")).toBe(false);
  });
});

// =========================================================================
// acceptEdits mode
// =========================================================================

describe("acceptEdits mode", () => {
  it("allows write tools without prompting", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: "/project/a.ts", content: "x" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("allows Bash commands in the allowlist", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "mkdir -p /project/new" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("asks for Bash commands not in the allowlist", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "curl https://example.com" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("ask");
  });
});

// =========================================================================
// Dangerous path bypass-immune
// =========================================================================

describe("dangerous path bypass-immune", () => {
  it("prompts for .ssh writes even in bypassPermissions mode", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: ".ssh/authorized_keys", content: "key" },
      ctx,
      makeContext({ mode: "bypassPermissions", workingDirectories: [] }),
    );
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("safetyCheck");
  });

  it("prompts for .env writes even in bypassPermissions mode", async () => {
    const result = await resolvePermission(
      writeFileTool,
      { file_path: ".env", content: "SECRET=1" },
      ctx,
      makeContext({ mode: "bypassPermissions", workingDirectories: [] }),
    );
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("safetyCheck");
  });
});

// =========================================================================
// isDangerousPath (second block)
// =========================================================================

describe("isDangerousPath", () => {
  it("detects .git/hooks paths as dangerous", () => {
    expect(isDangerousPath(".git/hooks/pre-commit")).toBe(true);
  });

  it("detects .env as dangerous", () => {
    expect(isDangerousPath(".env")).toBe(true);
  });

  it("detects .ssh/ paths as dangerous", () => {
    expect(isDangerousPath(".ssh/id_rsa")).toBe(true);
  });

  it("does not flag normal project files", () => {
    expect(isDangerousPath("src/index.ts")).toBe(false);
  });

  it("uses custom basePath for path resolution", () => {
    expect(isDangerousPath(".git/config", "/project")).toBe(true);
  });

  it("detects .claude/ paths as dangerous", () => {
    expect(isDangerousPath(".claude/settings.json")).toBe(true);
  });

  it("detects .mcp.json as dangerous", () => {
    expect(isDangerousPath(".mcp.json")).toBe(true);
  });

  it("detects .git/info/exclude as dangerous (catch-all .git/ protection)", () => {
    expect(isDangerousPath(".git/info/exclude")).toBe(true);
  });

  it("detects .git/packed-refs as dangerous", () => {
    expect(isDangerousPath(".git/packed-refs")).toBe(true);
  });

  it("detects .git/description as dangerous", () => {
    expect(isDangerousPath(".git/description")).toBe(true);
  });

  it("detects .git/shallow as dangerous", () => {
    expect(isDangerousPath(".git/shallow")).toBe(true);
  });

  it("detects bare .git directory name (no trailing slash) as dangerous", () => {
    expect(isDangerousPath(".git")).toBe(true);
  });

  it("detects bare .ssh directory name (no trailing slash) as dangerous", () => {
    expect(isDangerousPath(".ssh")).toBe(true);
  });

  it("detects bare .vscode directory name as dangerous", () => {
    expect(isDangerousPath(".vscode")).toBe(true);
  });

  it("detects bare .claude directory name as dangerous", () => {
    expect(isDangerousPath(".claude")).toBe(true);
  });

  it("detects bare .noumen directory name as dangerous", () => {
    expect(isDangerousPath(".noumen")).toBe(true);
  });
});

// =========================================================================
// acceptEdits compound command check
// =========================================================================

describe("acceptEdits compound command check", () => {
  it("blocks compound commands with disallowed subcommands", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "touch file && curl evil.com" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("ask");
    expect("message" in result && result.message).toContain("curl");
  });

  it("allows compound commands where all subcommands are in allowlist", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "mkdir foo && touch foo/bar" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("allow");
  });

  it("blocks piped commands with disallowed right-hand side", async () => {
    const result = await resolvePermission(
      bashTool,
      { command: "touch file | sh" },
      ctx,
      makeContext({ mode: "acceptEdits" }),
    );
    expect(result.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// acceptEdits working-directory enforcement
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

  it("enforces working directories for Bash commands with absolute path arguments", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "Run bash",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" };

    const decision = await resolvePermission(
      tool,
      { command: "cp /etc/shadow /tmp/exfil" },
      toolCtx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("workingDirectory");
  });

  it("allows Bash commands with relative path arguments in acceptEdits mode", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "Run bash",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" };

    const decision = await resolvePermission(
      tool,
      { command: "cp foo.ts bar.ts" },
      toolCtx,
      permCtx,
    );
    expect(decision.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// dangerous path patterns include .noumen/
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
// write/edit tool checkPermissions uses ctx.cwd
// ---------------------------------------------------------------------------
describe("write/edit tool checkPermissions uses ctx.cwd", () => {
  it("writeFileTool detects dangerous path relative to ctx.cwd", async () => {
    const ctx = { fs, computer, cwd: "/home/user/project" } as any;
    const result = await writeFileTool.checkPermissions!(
      { file_path: ".ssh/id_rsa" },
      ctx,
    );
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("safetyCheck");
  });

  it("writeFileTool allows safe path relative to ctx.cwd", async () => {
    const ctx = { fs, computer, cwd: "/home/user/project" } as any;
    const result = await writeFileTool.checkPermissions!(
      { file_path: "src/index.ts" },
      ctx,
    );
    expect(result.behavior).toBe("passthrough");
  });

  it("editFileTool detects dangerous path relative to ctx.cwd", async () => {
    const ctx = { fs, computer, cwd: "/home/user/project" } as any;
    const result = await editFileTool.checkPermissions!(
      { file_path: ".env" },
      ctx,
    );
    expect(result.behavior).toBe("ask");
    expect(result.reason).toBe("safetyCheck");
  });

  it("editFileTool allows safe path relative to ctx.cwd", async () => {
    const ctx = { fs, computer, cwd: "/home/user/project" } as any;
    const result = await editFileTool.checkPermissions!(
      { file_path: "src/main.ts" },
      ctx,
    );
    expect(result.behavior).toBe("passthrough");
  });
});

// ---------------------------------------------------------------------------
// acceptEdits bash allowlist: ln removed
// ---------------------------------------------------------------------------
describe("acceptEdits bash allowlist: ln removed", () => {
  it("ln command requires approval in acceptEdits mode", async () => {
    const tool = {
      name: "Bash",
      description: "Run bash",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(
      tool,
      { command: "ln -s /etc/passwd safe-name" },
      toolCtx,
      permCtx,
    );

    expect(decision.behavior).toBe("ask");
  });

  it("mkdir still allowed in acceptEdits mode", async () => {
    const tool = {
      name: "Bash",
      description: "Run bash",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(
      tool,
      { command: "mkdir -p /project/subdir" },
      toolCtx,
      permCtx,
    );

    expect(decision.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// acceptEdits mode: non-file tools require approval
// ---------------------------------------------------------------------------
describe("acceptEdits non-file tools", () => {
  it("requires approval for non-file, non-bash tools in acceptEdits mode", async () => {
    const tool: Tool = {
      name: "McpNetworkTool",
      description: "Makes network requests",
      parameters: { type: "object" as const, properties: {} },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, {}, toolCtx, permCtx);
    expect(decision.behavior).toBe("ask");
  });

  it("auto-allows file tools with file_path in acceptEdits mode", async () => {
    const tool: Tool = {
      name: "WriteFile",
      description: "Write a file",
      parameters: { type: "object" as const, properties: { file_path: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, { file_path: "/project/test.txt" }, toolCtx, permCtx);
    expect(decision.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// New dangerous path patterns (.ripgreprc, .noumen.json)
// ---------------------------------------------------------------------------
describe("new dangerous path patterns", () => {
  it("detects .ripgreprc as dangerous", () => {
    expect(isDangerousPath(".ripgreprc")).toBe(true);
  });

  it("detects .noumen.json as dangerous", () => {
    expect(isDangerousPath(".noumen.json")).toBe(true);
  });

  it("detects nested .ripgreprc as dangerous", () => {
    expect(isDangerousPath("home/user/.ripgreprc", "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dot-dir-driven dangerous paths
// ---------------------------------------------------------------------------
describe("isDangerousPath with dotDirNames override", () => {
  it("treats .cursor as dangerous when dotDirNames = ['.cursor']", () => {
    expect(isDangerousPath(".cursor/config", undefined, [".cursor"])).toBe(true);
  });

  it("does NOT flag .noumen when dotDirNames = ['.cursor']", () => {
    expect(isDangerousPath(".noumen/foo", undefined, [".cursor"])).toBe(false);
  });

  it("falls back to default protected list when dotDirNames is empty", () => {
    expect(isDangerousPath(".noumen/foo", undefined, [])).toBe(true);
    expect(isDangerousPath(".claude/foo", undefined, [])).toBe(true);
  });

  it("still protects static patterns (.git, .ssh) regardless of dotDirNames", () => {
    expect(isDangerousPath(".git/HEAD", undefined, [".cursor"])).toBe(true);
    expect(isDangerousPath(".ssh/id_rsa", undefined, [".cursor"])).toBe(true);
  });

  it("resolvePermission honors permCtx.dotDirNames for dangerous path checks", async () => {
    const tool: Tool = {
      name: "WriteFile",
      description: "Write a file",
      parameters: {
        type: "object" as const,
        properties: { file_path: { type: "string" } },
      },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: [],
      dotDirNames: [".cursor"],
    };
    const toolCtx = {
      fs: new MockFs(),
      computer: new MockComputer(),
      cwd: "/project",
    } as any;

    const cursorDecision = await resolvePermission(
      tool,
      { file_path: ".cursor/config" },
      toolCtx,
      permCtx,
    );
    expect(cursorDecision.behavior).toBe("ask");
    expect(cursorDecision.reason).toBe("safetyCheck");

    const noumenDecision = await resolvePermission(
      tool,
      { file_path: ".noumen/foo" },
      toolCtx,
      permCtx,
    );
    // With custom dotDirNames, .noumen is no longer protected — falls
    // through to the normal ask/allow pipeline for WriteFile.
    expect(noumenDecision.reason).not.toBe("safetyCheck");
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: auto mode without provider
// ---------------------------------------------------------------------------
describe("auto mode without provider", () => {
  it("returns ask with classifier fallback message when no provider is given", async () => {
    const tool: Tool = {
      name: "WriteFile",
      description: "Write a file",
      parameters: { type: "object" as const, properties: {} },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "auto",
      rules: [],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(
      tool,
      { command: "echo hi" },
      toolCtx,
      permCtx,
      { autoModeConfig: { classifierModel: "m" } },
    );
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("classifier");
    if (decision.behavior === "ask") {
      expect(decision.message).toContain("Auto-mode requires an AI provider");
    }
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: content-scoped ask rules
// ---------------------------------------------------------------------------
describe("content-scoped ask rules", () => {
  it("returns ask when a rule with behavior ask and prefix ruleContent matches", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "Run a command",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "bypassPermissions",
      rules: [
        { toolName: "Bash", behavior: "ask", ruleContent: "curl:*" },
      ],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, { command: "curl https://example.com" }, toolCtx, permCtx);
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("rule");
  });

  it("does not match content-scoped ask rule when command does not match ruleContent", async () => {
    const tool: Tool = {
      name: "Bash",
      description: "Run a command",
      parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "bypassPermissions",
      rules: [
        { toolName: "Bash", behavior: "ask", ruleContent: "curl:*" },
      ],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, { command: "echo hello" }, toolCtx, permCtx);
    // Does not match the ask rule, so bypassPermissions allows it
    expect(decision.behavior).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: bypassPermissions + requiresUserInteraction
// ---------------------------------------------------------------------------
describe("bypassPermissions with interactive tool", () => {
  it("returns ask with reason interaction when tool requires user interaction", async () => {
    const tool: Tool = {
      name: "AskUser",
      description: "Ask the user a question",
      parameters: { type: "object" as const, properties: { question: { type: "string" } } },
      requiresUserInteraction: true,
      async call() { return { content: "yes" }; },
    };
    const permCtx: PermissionContext = {
      mode: "bypassPermissions",
      rules: [],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, { question: "continue?" }, toolCtx, permCtx);
    expect(decision.behavior).toBe("ask");
    expect(decision.reason).toBe("interaction");
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: acceptEdits + destructive Bash through full pipeline
// ---------------------------------------------------------------------------
describe("acceptEdits with destructive bash through pipeline", () => {
  it("asks for destructive bash commands in acceptEdits mode", async () => {
    const permCtx: PermissionContext = {
      mode: "acceptEdits",
      rules: [],
      workingDirectories: ["/project"],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(
      bashTool,
      { command: "rm -rf /project/src" },
      toolCtx,
      permCtx,
    );
    expect(decision.behavior).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Gap coverage: passthrough preserves message and suggestions
// ---------------------------------------------------------------------------
describe("passthrough preserves message and suggestions", () => {
  it("surfaces message and suggestions from passthrough in ask result", async () => {
    const tool: Tool = {
      name: "CustomTool",
      description: "Custom",
      parameters: { type: "object" as const, properties: {} },
      async checkPermissions() {
        return {
          behavior: "passthrough" as const,
          message: "Custom warning message",
          suggestions: [
            { toolName: "CustomTool", behavior: "allow" as const },
          ],
        };
      },
      async call() { return { content: "ok" }; },
    };
    const permCtx: PermissionContext = {
      mode: "default",
      rules: [],
      workingDirectories: [],
    };
    const toolCtx = { fs: new MockFs(), computer: new MockComputer(), cwd: "/project" } as any;

    const decision = await resolvePermission(tool, {}, toolCtx, permCtx);
    expect(decision.behavior).toBe("ask");
    if (decision.behavior === "ask") {
      expect(decision.message).toBe("Custom warning message");
      expect(decision.suggestions).toEqual([
        { toolName: "CustomTool", behavior: "allow" },
      ]);
    }
  });
});
