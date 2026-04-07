import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAgentConfig } from "../agent-config.js";
import { DEFAULT_RETRY_CONFIG } from "../retry/types.js";

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

    it("expands true to { cwd: effectiveCwd }", () => {
      const { projectContextConfig } = resolveAgentConfig({
        cwd: "/my/project",
        projectContext: true,
      });
      expect(projectContextConfig).toEqual({ cwd: "/my/project" });
    });

    it("passes through object config as-is", () => {
      const custom = { cwd: "/other", include: ["*.md"] };
      const { projectContextConfig } = resolveAgentConfig({ projectContext: custom });
      expect(projectContextConfig).toBe(custom);
    });

    it("expands true using process.cwd() when no cwd given", () => {
      const { projectContextConfig } = resolveAgentConfig({ projectContext: true });
      expect(projectContextConfig).toEqual({ cwd: "/default/cwd" });
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
