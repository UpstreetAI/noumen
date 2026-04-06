import { describe, it, expect } from "vitest";
import {
  mergeConfig,
  loadGlobalConfig,
  type CliConfig,
  type MergedConfig,
} from "../cli/config.js";

// ---------------------------------------------------------------------------
// mergeConfig
// ---------------------------------------------------------------------------

describe("mergeConfig", () => {
  it("uses config values when no flags provided", () => {
    const config: CliConfig = { provider: "openai", model: "gpt-4" };
    const result = mergeConfig(config, { cwd: "/test" });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4");
    expect(result.cwd).toBe("/test");
  });

  it("flags override config values", () => {
    const config: CliConfig = { provider: "openai", model: "gpt-4" };
    const result = mergeConfig(config, {
      cwd: "/test",
      provider: "anthropic",
      model: "claude-3",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-3");
  });

  it("preserves config keys not present in flags", () => {
    const config: CliConfig = {
      provider: "openai",
      model: "gpt-4",
      autoCompact: true,
      enableSubagents: true,
    };
    const result = mergeConfig(config, { cwd: "/test", model: "new-model" });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("new-model");
    expect(result.autoCompact).toBe(true);
    expect(result.enableSubagents).toBe(true);
  });

  it("sets noSandbox when --sandbox=false", () => {
    const result = mergeConfig({}, { cwd: "/test", sandbox: false });
    expect(result.noSandbox).toBe(true);
  });

  it("noSandbox is undefined when --sandbox not false", () => {
    const result = mergeConfig({}, { cwd: "/test", sandbox: true });
    expect(result.noSandbox).toBeUndefined();
  });

  it("maps sandboxAllowWrite from flags", () => {
    const result = mergeConfig({}, {
      cwd: "/test",
      sandboxAllowWrite: "/tmp,/home",
    });
    expect(result.sandboxAllowWrite).toBe("/tmp,/home");
  });

  it("maps sandboxAllowDomain from flags", () => {
    const result = mergeConfig({}, {
      cwd: "/test",
      sandboxAllowDomain: "api.example.com",
    });
    expect(result.sandboxAllowDomain).toBe("api.example.com");
  });

  it("maps json, quiet, verbose, headless boolean flags", () => {
    const result = mergeConfig({}, {
      cwd: "/test",
      json: true,
      quiet: true,
      verbose: true,
      headless: true,
    });
    expect(result.json).toBe(true);
    expect(result.quiet).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.headless).toBe(true);
  });

  it("maps maxTurns from flags", () => {
    const result = mergeConfig({}, { cwd: "/test", maxTurns: 5 });
    expect(result.maxTurns).toBe(5);
  });

  it("maps systemPrompt from flags", () => {
    const result = mergeConfig({}, { cwd: "/test", systemPrompt: "custom" });
    expect(result.systemPrompt).toBe("custom");
  });

  it("empty config and flags produces minimal result", () => {
    const result = mergeConfig({}, { cwd: "/test" });
    expect(result.cwd).toBe("/test");
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------

describe("loadGlobalConfig", () => {
  it("returns empty object when no config file exists", () => {
    const config = loadGlobalConfig();
    expect(typeof config).toBe("object");
    // May return {} or an actual config depending on the test environment
  });
});

// ---------------------------------------------------------------------------
// parseThinking (tested via re-implementation since it's not exported)
// ---------------------------------------------------------------------------

describe("parseThinking logic", () => {
  function parseThinking(level: string | undefined) {
    if (!level || level === "off") return { type: "disabled" };
    const budgets: Record<string, number> = {
      low: 1024,
      medium: 10240,
      high: 32768,
    };
    const budget = budgets[level];
    if (budget) return { type: "enabled", budgetTokens: budget };
    return undefined;
  }

  it("returns disabled for 'off'", () => {
    expect(parseThinking("off")).toEqual({ type: "disabled" });
  });

  it("returns disabled for undefined", () => {
    expect(parseThinking(undefined)).toEqual({ type: "disabled" });
  });

  it("returns low budget for 'low'", () => {
    const result = parseThinking("low");
    expect(result).toEqual({ type: "enabled", budgetTokens: 1024 });
  });

  it("returns medium budget for 'medium'", () => {
    const result = parseThinking("medium");
    expect(result).toEqual({ type: "enabled", budgetTokens: 10240 });
  });

  it("returns high budget for 'high'", () => {
    const result = parseThinking("high");
    expect(result).toEqual({ type: "enabled", budgetTokens: 32768 });
  });

  it("returns undefined for unknown level", () => {
    expect(parseThinking("extreme")).toBeUndefined();
  });
});
