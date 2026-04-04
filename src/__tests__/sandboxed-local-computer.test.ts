import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  wrapWithSandbox: vi.fn(async (cmd: string) => `SANDBOXED:${cmd}`),
  reset: vi.fn().mockResolvedValue(undefined),
  cleanupAfterCommand: vi.fn(),
  isSandboxingEnabled: vi.fn(() => true),
  isSupportedPlatform: vi.fn(() => true),
  checkDependencies: vi.fn(() => ({ satisfied: true })),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: mocks,
}));

import { SandboxedLocalComputer } from "../virtual/sandboxed-local-computer.js";

describe("SandboxedLocalComputer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes sandbox on first executeCommand", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });
    expect(mocks.initialize).not.toHaveBeenCalled();

    await comp.executeCommand("echo test");
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
  });

  it("initializes exactly once across multiple commands", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo 1");
    await comp.executeCommand("echo 2");
    await comp.executeCommand("echo 3");

    expect(mocks.initialize).toHaveBeenCalledTimes(1);
  });

  it("calls wrapWithSandbox for every command", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo first");
    await comp.executeCommand("echo second");

    expect(mocks.wrapWithSandbox).toHaveBeenCalledTimes(2);
    expect(mocks.wrapWithSandbox).toHaveBeenCalledWith("echo first");
    expect(mocks.wrapWithSandbox).toHaveBeenCalledWith("echo second");
  });

  it("calls cleanupAfterCommand after each execution", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo test");
    expect(mocks.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("passes config to initialize", async () => {
    const comp = new SandboxedLocalComputer({
      defaultCwd: "/my/project",
      sandbox: {
        filesystem: {
          allowWrite: ["/my/project", "/tmp"],
          denyRead: ["/etc/shadow"],
        },
        network: {
          allowedDomains: ["example.com"],
        },
      },
    });

    await comp.executeCommand("echo test");

    expect(mocks.initialize).toHaveBeenCalledWith({
      filesystem: {
        allowWrite: ["/my/project", "/tmp"],
        denyWrite: [],
        denyRead: ["/etc/shadow"],
        allowRead: [],
      },
      network: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
      },
    });
  });

  it("uses default config when no sandbox options provided", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/my/cwd" });

    await comp.executeCommand("echo test");

    expect(mocks.initialize).toHaveBeenCalledWith({
      filesystem: {
        allowWrite: ["/my/cwd"],
        denyWrite: [],
        denyRead: [],
        allowRead: [],
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
    });
  });

  it("resets sandbox manager on dispose", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo test");
    await comp.dispose();

    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("dispose is a no-op if never initialized", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });
    await comp.dispose();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("can reinitialize after dispose", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo 1");
    await comp.dispose();
    await comp.executeCommand("echo 2");

    expect(mocks.initialize).toHaveBeenCalledTimes(2);
  });

  it("propagates initialization errors instead of swallowing them", async () => {
    mocks.initialize.mockRejectedValueOnce(new Error("platform not supported"));
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await expect(comp.executeCommand("echo test")).rejects.toThrow(
      "platform not supported",
    );
  });
});
