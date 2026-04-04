import { describe, it, expect } from "vitest";
import { mergeConfig, type CliConfig } from "../cli/config.js";

describe("CLI sandbox config merging", () => {
  const base: CliConfig = { provider: "openai" };

  it("sets noSandbox when --no-sandbox flag is passed (commander sets sandbox=false)", () => {
    const merged = mergeConfig(base, { sandbox: false });
    expect(merged.noSandbox).toBe(true);
  });

  it("does not set noSandbox when sandbox flag is not passed", () => {
    const merged = mergeConfig(base, {});
    expect(merged.noSandbox).toBeUndefined();
  });

  it("parses --sandbox-allow-write as a string", () => {
    const merged = mergeConfig(base, {
      sandboxAllowWrite: "/tmp,/data",
    });
    expect(merged.sandboxAllowWrite).toBe("/tmp,/data");
  });

  it("parses --sandbox-allow-domain as a string", () => {
    const merged = mergeConfig(base, {
      sandboxAllowDomain: "example.com,api.dev",
    });
    expect(merged.sandboxAllowDomain).toBe("example.com,api.dev");
  });

  it("preserves all merged config fields together", () => {
    const merged = mergeConfig(base, {
      sandbox: false,
      sandboxAllowWrite: "/tmp",
      sandboxAllowDomain: "example.com",
      cwd: "/my/project",
    });
    expect(merged.noSandbox).toBe(true);
    expect(merged.sandboxAllowWrite).toBe("/tmp");
    expect(merged.sandboxAllowDomain).toBe("example.com");
    expect(merged.cwd).toBe("/my/project");
  });
});
