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
// stripForRuleMatching
// =========================================================================

import { stripForRuleMatching } from "../permissions/rules.js";

describe("stripForRuleMatching", () => {
  it("strips env var prefixes", () => {
    expect(stripForRuleMatching("FOO=bar npm test")).toBe("npm test");
    expect(stripForRuleMatching("A=1 B=2 cmd arg")).toBe("cmd arg");
  });

  it("strips safe wrapper commands", () => {
    expect(stripForRuleMatching("nice -n5 npm test")).toBe("npm test");
    expect(stripForRuleMatching("nohup node server.js")).toBe("node server.js");
    expect(stripForRuleMatching("stdbuf -oL npm test")).toBe("npm test");
  });

  it("strips combined env vars and wrappers", () => {
    expect(stripForRuleMatching("FOO=bar nice -n5 npm test")).toBe("npm test");
  });

  it("returns command unchanged when no wrappers", () => {
    expect(stripForRuleMatching("npm test")).toBe("npm test");
    expect(stripForRuleMatching("git status")).toBe("git status");
  });
});

// ---------------------------------------------------------------------------
// containsShellExpansion detects backticks
// ---------------------------------------------------------------------------
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
