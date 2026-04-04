import { describe, it, expect } from "vitest";
import {
  normalizeNameForMCP,
  buildMcpToolName,
  getMcpPrefix,
  parseMcpToolName,
} from "../mcp/normalization.js";

describe("normalizeNameForMCP", () => {
  it("passes through valid names", () => {
    expect(normalizeNameForMCP("my-server")).toBe("my-server");
    expect(normalizeNameForMCP("my_server")).toBe("my_server");
    expect(normalizeNameForMCP("server123")).toBe("server123");
  });

  it("replaces dots with underscores", () => {
    expect(normalizeNameForMCP("my.server")).toBe("my_server");
  });

  it("replaces spaces with underscores", () => {
    expect(normalizeNameForMCP("my server")).toBe("my_server");
  });

  it("replaces special characters with underscores", () => {
    expect(normalizeNameForMCP("my@server!v2")).toBe("my_server_v2");
  });
});

describe("getMcpPrefix", () => {
  it("creates the correct prefix", () => {
    expect(getMcpPrefix("github")).toBe("mcp__github__");
    expect(getMcpPrefix("my.server")).toBe("mcp__my_server__");
  });
});

describe("buildMcpToolName", () => {
  it("creates fully qualified name", () => {
    expect(buildMcpToolName("github", "list_repos")).toBe("mcp__github__list_repos");
  });

  it("normalizes both server and tool names", () => {
    expect(buildMcpToolName("my.server", "get items")).toBe("mcp__my_server__get_items");
  });
});

describe("parseMcpToolName", () => {
  it("parses valid MCP tool names", () => {
    const result = parseMcpToolName("mcp__github__list_repos");
    expect(result).toEqual({ serverName: "github", toolName: "list_repos" });
  });

  it("handles tool names with double underscores", () => {
    const result = parseMcpToolName("mcp__server__my__tool");
    expect(result).toEqual({ serverName: "server", toolName: "my__tool" });
  });

  it("returns null for non-MCP names", () => {
    expect(parseMcpToolName("ReadFile")).toBeNull();
    expect(parseMcpToolName("not__mcp__tool")).toBeNull();
  });

  it("returns null for incomplete MCP names", () => {
    expect(parseMcpToolName("mcp__server")).toBeNull();
  });
});
