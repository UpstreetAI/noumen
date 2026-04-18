import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAgentConfig } from "../agent-config.js";
import { DEFAULT_RETRY_CONFIG } from "../retry/types.js";
import { DEFAULT_DOT_DIRS } from "../config/dot-dirs.js";

describe("resolveAgentConfig", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    process.cwd = vi.fn().mockReturnValue("/default/cwd");
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  describe("effectiveCwd", () => {
    it("uses top-level cwd when provided", () => {
      const { effectiveCwd } = resolveAgentConfig({ cwd: "/top" });
      expect(effectiveCwd).toBe("/top");
    });

    it("falls back to options cwd", () => {
      const { effectiveCwd } = resolveAgentConfig({ optionsCwd: "/opts" });
      expect(effectiveCwd).toBe("/opts");
    });

    it("falls back to process.cwd()", () => {
      const { effectiveCwd } = resolveAgentConfig({});
      expect(effectiveCwd).toBe("/default/cwd");
    });

    it("top-level cwd takes precedence over options cwd", () => {
      const { effectiveCwd } = resolveAgentConfig({ cwd: "/top", optionsCwd: "/opts" });
      expect(effectiveCwd).toBe("/top");
    });
  });

  describe("retryConfig", () => {
    it("returns undefined when retry is absent", () => {
      const { retryConfig } = resolveAgentConfig({});
      expect(retryConfig).toBeUndefined();
    });

    it("returns DEFAULT_RETRY_CONFIG when retry is true", () => {
      const { retryConfig } = resolveAgentConfig({ retry: true });
      expect(retryConfig).toEqual(DEFAULT_RETRY_CONFIG);
    });

    it("passes through retry object as-is", () => {
      const custom = { maxRetries: 5, baseDelayMs: 500 };
      const { retryConfig } = resolveAgentConfig({ retry: custom });
      expect(retryConfig).toBe(custom);
    });

    it("returns undefined when retry is false", () => {
      const { retryConfig } = resolveAgentConfig({ retry: false });
      expect(retryConfig).toBeUndefined();
    });
  });

  describe("projectContextConfig", () => {
    it("returns undefined when absent", () => {
      const { projectContextConfig } = resolveAgentConfig({});
      expect(projectContextConfig).toBeUndefined();
    });

    it("expands true to { cwd: effectiveCwd, dotDirs: DEFAULT_DOT_DIRS }", () => {
      const { projectContextConfig } = resolveAgentConfig({
        cwd: "/my/project",
        projectContext: true,
      });
      expect(projectContextConfig).toEqual({
        cwd: "/my/project",
        dotDirs: DEFAULT_DOT_DIRS,
      });
    });

    it("passes through object config, injecting default dotDirs if absent", () => {
      const custom = { cwd: "/other", include: ["*.md"] } as unknown as Parameters<typeof resolveAgentConfig>[0]["projectContext"];
      const { projectContextConfig } = resolveAgentConfig({ projectContext: custom });
      expect(projectContextConfig).toMatchObject({
        cwd: "/other",
        dotDirs: DEFAULT_DOT_DIRS,
      });
    });

    it("preserves an explicit dotDirs on projectContext", () => {
      const { projectContextConfig } = resolveAgentConfig({
        cwd: "/proj",
        projectContext: { cwd: "/proj", dotDirs: { names: [".custom"] } },
      });
      expect(projectContextConfig?.dotDirs?.names).toEqual([".custom"]);
    });

    it("expands true using process.cwd() when no cwd given", () => {
      const { projectContextConfig } = resolveAgentConfig({ projectContext: true });
      expect(projectContextConfig).toEqual({
        cwd: "/default/cwd",
        dotDirs: DEFAULT_DOT_DIRS,
      });
    });
  });

  describe("dotDirs", () => {
    it("defaults to DEFAULT_DOT_DIRS when unset", () => {
      const { dotDirs, dotDirResolver } = resolveAgentConfig({});
      expect(dotDirs).toEqual(DEFAULT_DOT_DIRS);
      expect(dotDirResolver.writePath("/x")).toBe("/x/.noumen");
    });

    it("threads custom dotDirs through to the resolver", () => {
      const { dotDirs, dotDirResolver } = resolveAgentConfig({
        dotDirs: { names: [".custom", ".noumen"] },
      });
      expect(dotDirs.names).toEqual([".custom", ".noumen"]);
      expect(dotDirResolver.writePath("/x")).toBe("/x/.custom");
    });

    it("propagates dotDirs into a boolean projectContext", () => {
      const { projectContextConfig } = resolveAgentConfig({
        cwd: "/proj",
        projectContext: true,
        dotDirs: { names: [".custom"] },
      });
      expect(projectContextConfig?.dotDirs?.names).toEqual([".custom"]);
    });

    it("respects projectContext.dotDirs over top-level dotDirs", () => {
      const { projectContextConfig } = resolveAgentConfig({
        cwd: "/proj",
        projectContext: { cwd: "/proj", dotDirs: { names: [".ctx"] } },
        dotDirs: { names: [".top"] },
      });
      expect(projectContextConfig?.dotDirs?.names).toEqual([".ctx"]);
    });
  });

  describe("mcpServerConfigs", () => {
    it("returns undefined for empty object", () => {
      const { mcpServerConfigs } = resolveAgentConfig({ mcpServers: {} });
      expect(mcpServerConfigs).toBeUndefined();
    });

    it("returns undefined when absent", () => {
      const { mcpServerConfigs } = resolveAgentConfig({});
      expect(mcpServerConfigs).toBeUndefined();
    });

    it("passes through non-empty config", () => {
      const config = { server1: { command: "npx", args: ["-y", "tool"] } };
      const { mcpServerConfigs } = resolveAgentConfig({ mcpServers: config });
      expect(mcpServerConfigs).toBe(config);
    });
  });

  describe("lspConfigs", () => {
    it("returns undefined for empty object", () => {
      const { lspConfigs } = resolveAgentConfig({ lsp: {} });
      expect(lspConfigs).toBeUndefined();
    });

    it("returns undefined when absent", () => {
      const { lspConfigs } = resolveAgentConfig({});
      expect(lspConfigs).toBeUndefined();
    });

    it("passes through non-empty config", () => {
      const config = { typescript: { command: "tsserver", args: ["--stdio"] } };
      const { lspConfigs } = resolveAgentConfig({ lsp: config });
      expect(lspConfigs).toBe(config);
    });
  });
});
