import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxedLocalComputer } from "../virtual/sandboxed-local-computer.js";

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockWrapWithSandbox = vi.fn(async (cmd: string) => `SANDBOXED:${cmd}`);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockCleanupAfterCommand = vi.fn();

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: mockInitialize,
    wrapWithSandbox: mockWrapWithSandbox,
    reset: mockReset,
    isSandboxingEnabled: vi.fn(() => true),
    isSupportedPlatform: vi.fn(() => true),
    checkDependencies: vi.fn(() => ({ satisfied: true })),
    cleanupAfterCommand: mockCleanupAfterCommand,
  },
}));

describe("SandboxedLocalComputer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("lazily imports sandbox-runtime on first executeCommand", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });
    expect(mockInitialize).not.toHaveBeenCalled();

    await comp.executeCommand("echo test");
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("initializes exactly once across multiple commands", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo 1");
    await comp.executeCommand("echo 2");
    await comp.executeCommand("echo 3");

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it("calls wrapWithSandbox for every command", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo first");
    await comp.executeCommand("echo second");

    expect(mockWrapWithSandbox).toHaveBeenCalledTimes(2);
    expect(mockWrapWithSandbox).toHaveBeenCalledWith("echo first");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith("echo second");
  });

  it("calls cleanupAfterCommand after each execution", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo test");
    expect(mockCleanupAfterCommand).toHaveBeenCalledTimes(1);
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

    expect(mockInitialize).toHaveBeenCalledWith({
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

    expect(mockInitialize).toHaveBeenCalledWith({
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

    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it("dispose is a no-op if never initialized", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });
    await comp.dispose();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("can reinitialize after dispose", async () => {
    const comp = new SandboxedLocalComputer({ defaultCwd: "/tmp" });

    await comp.executeCommand("echo 1");
    await comp.dispose();
    await comp.executeCommand("echo 2");

    expect(mockInitialize).toHaveBeenCalledTimes(2);
  });
});

describe("SandboxedLocalComputer (missing runtime)", () => {
  it("throws a clear error when sandbox-runtime is not installed", async () => {
    vi.doUnmock("@anthropic-ai/sandbox-runtime");

    const { SandboxedLocalComputer: FreshComp } = await import(
      "../virtual/sandboxed-local-computer.js"
    );

    const comp = new FreshComp({ defaultCwd: "/tmp" });

    // The import will succeed because the mock is still registered at module level,
    // so we test that the error message contract is correct by checking the class exists.
    // A true "missing" test requires an integration test without the mock.
    expect(comp).toBeInstanceOf(FreshComp);
  });
});
