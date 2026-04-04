import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "../providers/types.js";
import {
  sortToolDefinitionsForCache,
  getMessageCacheBreakpointIndex,
} from "../providers/cache.js";
import type { ChatMessage } from "../session/types.js";

function makeTool(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

describe("sortToolDefinitionsForCache", () => {
  it("sorts all tools alphabetically when no MCP names", () => {
    const tools = [makeTool("Zebra"), makeTool("Alpha"), makeTool("Mid")];
    const sorted = sortToolDefinitionsForCache(tools);
    expect(sorted.map((t) => t.function.name)).toEqual(["Alpha", "Mid", "Zebra"]);
  });

  it("places built-in tools before MCP tools, both sorted", () => {
    const mcpNames = new Set(["mcp_read", "mcp_aaa"]);
    const tools = [
      makeTool("mcp_read"),
      makeTool("WriteFile"),
      makeTool("mcp_aaa"),
      makeTool("ReadFile"),
      makeTool("Bash"),
    ];

    const sorted = sortToolDefinitionsForCache(tools, mcpNames);
    const names = sorted.map((t) => t.function.name);
    expect(names).toEqual(["Bash", "ReadFile", "WriteFile", "mcp_aaa", "mcp_read"]);
  });

  it("handles empty tool list", () => {
    expect(sortToolDefinitionsForCache([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const tools = [makeTool("B"), makeTool("A")];
    const original = [...tools];
    sortToolDefinitionsForCache(tools);
    expect(tools[0].function.name).toBe(original[0].function.name);
  });
});

describe("getMessageCacheBreakpointIndex", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];

  it("returns last message index by default", () => {
    expect(getMessageCacheBreakpointIndex(msgs)).toBe(2);
  });

  it("returns second-to-last when skipCacheWrite", () => {
    expect(getMessageCacheBreakpointIndex(msgs, true)).toBe(1);
  });

  it("returns last if only one message with skipCacheWrite", () => {
    expect(getMessageCacheBreakpointIndex([msgs[0]], true)).toBe(0);
  });

  it("returns -1 for empty messages", () => {
    expect(getMessageCacheBreakpointIndex([])).toBe(-1);
  });
});
