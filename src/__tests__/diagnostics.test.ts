import { describe, it, expect, vi } from "vitest";
import {
  timedCheck,
  formatDiagError,
  checkProviderHealth,
  checkVirtualFs,
  checkVirtualComputer,
  summarizeMcpStatus,
  summarizeLspStatus,
} from "../diagnostics.js";
import type { VirtualFs } from "../virtual/fs.js";
import type { VirtualComputer } from "../virtual/computer.js";

// ---------------------------------------------------------------------------
// timedCheck
// ---------------------------------------------------------------------------

describe("timedCheck", () => {
  it("returns value and latency on success", async () => {
    const result = await timedCheck(async () => 42, 5000);
    expect(result.value).toBe(42);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects on timeout", async () => {
    await expect(
      timedCheck(() => new Promise(() => {}), 50),
    ).rejects.toThrow("Timed out");
  });
});

// ---------------------------------------------------------------------------
// formatDiagError
// ---------------------------------------------------------------------------

describe("formatDiagError", () => {
  it("extracts message from Error", () => {
    expect(formatDiagError(new Error("boom"))).toBe("boom");
  });

  it("converts non-Error to string", () => {
    expect(formatDiagError("oops")).toBe("oops");
    expect(formatDiagError(42)).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// checkProviderHealth
// ---------------------------------------------------------------------------

describe("checkProviderHealth", () => {
  it("returns ok when provider streams successfully", async () => {
    const provider = {
      chat: vi.fn().mockReturnValue(
        (async function* () { yield { choices: [{ delta: { content: "ok" } }] }; })(),
      ),
    };
    const result = await checkProviderHealth(provider as any, "gpt-4", 5000);
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gpt-4");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when provider throws", async () => {
    const provider = {
      chat: vi.fn().mockReturnValue(
        (async function* () { throw new Error("connection refused"); })(),
      ),
    };
    const result = await checkProviderHealth(provider as any, "gpt-4", 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });
});

// ---------------------------------------------------------------------------
// checkVirtualFs
// ---------------------------------------------------------------------------

describe("checkVirtualFs", () => {
  it("returns ok when fs.exists succeeds", async () => {
    const fs = { exists: vi.fn().mockResolvedValue(true) } as unknown as VirtualFs;
    const result = await checkVirtualFs(fs, 5000);
    expect(result.ok).toBe(true);
  });

  it("returns error when fs.exists throws", async () => {
    const fs = { exists: vi.fn().mockRejectedValue(new Error("no fs")) } as unknown as VirtualFs;
    const result = await checkVirtualFs(fs, 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no fs");
  });
});

// ---------------------------------------------------------------------------
// checkVirtualComputer
// ---------------------------------------------------------------------------

describe("checkVirtualComputer", () => {
  it("returns ok when command exits 0", async () => {
    const computer = {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" }),
    } as unknown as VirtualComputer;
    const result = await checkVirtualComputer(computer, 5000);
    expect(result.ok).toBe(true);
  });

  it("returns warning when command exits non-zero", async () => {
    const computer = {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "err" }),
    } as unknown as VirtualComputer;
    const result = await checkVirtualComputer(computer, 5000);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain("non-zero");
  });

  it("returns error when command throws", async () => {
    const computer = {
      executeCommand: vi.fn().mockRejectedValue(new Error("no shell")),
    } as unknown as VirtualComputer;
    const result = await checkVirtualComputer(computer, 5000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no shell");
  });
});

// ---------------------------------------------------------------------------
// summarizeMcpStatus
// ---------------------------------------------------------------------------

describe("summarizeMcpStatus", () => {
  it("marks connected servers as ok", () => {
    const result = summarizeMcpStatus([
      { name: "server1", status: "connected", toolCount: 5 },
    ]);
    expect(result.server1.ok).toBe(true);
    expect(result.server1.toolCount).toBe(5);
  });

  it("marks needs-auth servers with warning", () => {
    const result = summarizeMcpStatus([
      { name: "s2", status: "needs-auth" },
    ]);
    expect(result.s2.ok).toBe(false);
    expect(result.s2.warning).toContain("OAuth");
  });

  it("marks failed servers with error", () => {
    const result = summarizeMcpStatus([
      { name: "s3", status: "failed" },
    ]);
    expect(result.s3.ok).toBe(false);
    expect(result.s3.error).toContain("failed");
  });

  it("handles empty array", () => {
    expect(summarizeMcpStatus([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// summarizeLspStatus
// ---------------------------------------------------------------------------

describe("summarizeLspStatus", () => {
  it("marks running servers as ok", () => {
    const result = summarizeLspStatus([
      { name: "ts-server", state: "running" },
    ]);
    expect(result["ts-server"].ok).toBe(true);
  });

  it("marks idle servers as ok without warning", () => {
    const result = summarizeLspStatus([
      { name: "ts-server", state: "idle" },
    ]);
    expect(result["ts-server"].ok).toBe(false);
    expect(result["ts-server"].warning).toBeUndefined();
  });

  it("marks errored servers with warning", () => {
    const result = summarizeLspStatus([
      { name: "py-server", state: "crashed" },
    ]);
    expect(result["py-server"].ok).toBe(false);
    expect(result["py-server"].warning).toContain("crashed");
  });

  it("handles empty array", () => {
    expect(summarizeLspStatus([])).toEqual({});
  });
});
