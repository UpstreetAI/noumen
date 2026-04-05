import { describe, it, expect } from "vitest";
import { isPrivateHost, isPrivateIP, webFetchTool } from "../tools/web-fetch.js";

// ---------------------------------------------------------------------------
// Sandbox path traversal prevention
// ---------------------------------------------------------------------------
describe("sandbox path traversal prevention", () => {
  it("docker-fs resolvePath blocks relative ../", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect(() => (dfs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("docker-fs resolvePath allows paths within workingDir", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect((dfs as any).resolvePath("subdir/file.txt")).toBe("/home/user/subdir/file.txt");
  });

  it("e2b-fs resolvePath blocks relative ../", async () => {
    const { E2BFs } = await import("../virtual/e2b-fs.js");
    const mockSandbox = {} as any;
    const efs = new E2BFs({ sandbox: mockSandbox, workingDir: "/home/user" });
    expect(() => (efs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("sprites-fs resolvePath blocks relative ../", async () => {
    const { SpritesFs } = await import("../virtual/sprites-fs.js");
    const sfs = new SpritesFs({ token: "t", spriteName: "s", workingDir: "/home/sprite" });
    expect(() => (sfs as any).resolvePath("../../etc/passwd")).toThrow("escapes working directory");
  });

  it("absolute paths within workingDir are allowed in remote FS backends", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect((dfs as any).resolvePath("/home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("absolute paths outside workingDir are blocked in remote FS backends", async () => {
    const { DockerFs } = await import("../virtual/docker-fs.js");
    const mockContainer = {} as any;
    const dfs = new DockerFs({ container: mockContainer, workingDir: "/home/user" });
    expect(() => (dfs as any).resolvePath("/etc/passwd")).toThrow("outside working directory");
  });
});

// ---------------------------------------------------------------------------
// WebFetch SSRF prevention
// ---------------------------------------------------------------------------
describe("WebFetch SSRF prevention", () => {
  it("blocks localhost", () => {
    expect(isPrivateHost("localhost")).toBe(true);
  });

  it("blocks 127.0.0.1", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
  });

  it("blocks 10.x.x.x", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16-31.x.x", () => {
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });

  it("blocks 192.168.x.x", () => {
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("blocks 169.254.x.x (link-local)", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });

  it("blocks ::1 and [::1]", () => {
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
  });

  it("allows public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("api.github.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP for DNS rebinding prevention
// ---------------------------------------------------------------------------
describe("isPrivateIP for DNS rebinding", () => {
  it("blocks loopback IPs", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.0.0.2")).toBe(true);
  });

  it("blocks RFC-1918 ranges", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });

  it("blocks link-local", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("[::1]")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("93.184.216.34")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebFetch URL credential blocking
// ---------------------------------------------------------------------------
describe("WebFetch URL credential blocking", () => {
  const ctx = { fs: {} as any, computer: {} as any, cwd: "/project" };

  it("blocks URLs with embedded username", async () => {
    const result = await webFetchTool.call({ url: "https://user@internal-api.com/data" }, ctx as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credentials");
  });

  it("blocks URLs with embedded username and password", async () => {
    const result = await webFetchTool.call({ url: "https://user:pass@internal-api.com/data" }, ctx as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credentials");
  });
});

// ---------------------------------------------------------------------------
// WebFetch HTTP to HTTPS upgrade
// ---------------------------------------------------------------------------
describe("WebFetch HTTP upgrade", () => {
  const ctx = { fs: {} as any, computer: {} as any, cwd: "/project" };

  it("upgrades http to https (private host check uses upgraded URL)", async () => {
    const result = await webFetchTool.call({ url: "http://localhost/test" }, ctx as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("private");
  });
});
