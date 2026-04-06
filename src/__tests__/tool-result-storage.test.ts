import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  persistToolResult,
  enforceToolResultStorageBudget,
  reconstructContentReplacementState,
  applyPersistedReplacements,
  createContentReplacementState,
  type ToolResultStorageConfig,
} from "../compact/tool-result-storage.js";
import type { VirtualFs } from "../virtual/fs.js";
import type { ChatMessage } from "../session/types.js";

function createMockFs(): VirtualFs {
  const files = new Map<string, string>();
  return {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (!content) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    writeFile: vi.fn(async (path: string, content: string, opts?: any) => {
      if (opts?.flag === "wx" && files.has(path)) {
        const err = new Error(`EEXIST: ${path}`) as any;
        err.code = "EEXIST";
        throw err;
      }
      files.set(path, content);
    }),
    appendFile: vi.fn(),
    deleteFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(async () => []),
    exists: vi.fn(async (path: string) => files.has(path)),
    stat: vi.fn(),
  };
}

describe("persistToolResult", () => {
  let fs: VirtualFs;
  const config: ToolResultStorageConfig = {
    enabled: true,
    defaultThreshold: 100,
    previewChars: 20,
  };

  beforeEach(() => {
    fs = createMockFs();
  });

  it("returns null for content below threshold", async () => {
    const result = await persistToolResult(fs, "sess1", "tc1", "Grep", "short", config);
    expect(result).toBeNull();
  });

  it("spills content above threshold to disk", async () => {
    const bigContent = "x".repeat(200);
    const result = await persistToolResult(fs, "sess1", "tc1", "Grep", bigContent, config);

    expect(result).not.toBeNull();
    expect(result).toContain("<persisted-output");
    expect(result).toContain('size="200"');
    expect(fs.mkdir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("tc1.txt"),
      bigContent,
    );
  });

  it("respects per-tool threshold overrides", async () => {
    const configWithOverride: ToolResultStorageConfig = {
      ...config,
      perToolThresholds: { ReadFile: Infinity },
    };
    const bigContent = "x".repeat(200);
    const result = await persistToolResult(fs, "sess1", "tc1", "ReadFile", bigContent, configWithOverride);
    expect(result).toBeNull();
  });

  it("does not overwrite if file already exists (EEXIST is silently caught)", async () => {
    const bigContent = "x".repeat(200);
    // First write succeeds
    await persistToolResult(fs, "sess1", "tc1", "Grep", bigContent, config);
    // Second write — wx flag causes EEXIST, which is caught silently
    const result = await persistToolResult(fs, "sess1", "tc1", "Grep", bigContent, config);
    expect(result).not.toBeNull();
    // writeFile is called both times (second one throws EEXIST, caught internally)
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });
});

describe("enforceToolResultStorageBudget", () => {
  let fs: VirtualFs;

  beforeEach(() => {
    fs = createMockFs();
  });

  it("no-ops when disabled", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "Grep", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc1", content: "x".repeat(500_000) },
    ];
    const result = await enforceToolResultStorageBudget(
      messages,
      { enabled: false },
      fs,
      "sess1",
    );
    expect(result.spilledEntries).toHaveLength(0);
  });

  it("spills large results when group exceeds budget", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [
        { id: "tc1", type: "function", function: { name: "Grep", arguments: "{}" } },
        { id: "tc2", type: "function", function: { name: "Grep", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "tc1", content: "a".repeat(150_000) },
      { role: "tool", tool_call_id: "tc2", content: "b".repeat(100_000) },
    ];
    const config: ToolResultStorageConfig = {
      enabled: true,
      perMessageBudget: 200_000,
      defaultThreshold: 50_000,
      previewChars: 500,
    };
    const result = await enforceToolResultStorageBudget(messages, config, fs, "sess1");

    expect(result.spilledEntries.length).toBeGreaterThan(0);
    expect(result.tokensFreed).toBeGreaterThan(0);
  });
});

describe("reconstructContentReplacementState", () => {
  it("rebuilds state from records", () => {
    const records = [
      { toolUseId: "tc1", replacement: "<persisted-output>..." },
      { toolUseId: "tc2", replacement: "<persisted-output>..." },
    ];
    const state = reconstructContentReplacementState(records);
    expect(state.seenIds.has("tc1")).toBe(true);
    expect(state.replacements.get("tc1")).toBe("<persisted-output>...");
    expect(state.replacements.size).toBe(2);
  });

  it("marks tool message IDs as seen when messages provided", () => {
    const messages: ChatMessage[] = [
      { role: "tool", tool_call_id: "tc3", content: "hello" },
    ];
    const state = reconstructContentReplacementState([], messages);
    expect(state.seenIds.has("tc3")).toBe(true);
    expect(state.replacements.size).toBe(0);
  });
});

describe("applyPersistedReplacements", () => {
  it("replaces tool messages with stored stubs", () => {
    const state = createContentReplacementState();
    state.replacements.set("tc1", "<stub>");

    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "tc1", content: "original big content" },
      { role: "tool", tool_call_id: "tc2", content: "keep this" },
    ];

    const result = applyPersistedReplacements(messages, state);
    expect((result[1] as { content: string }).content).toBe("<stub>");
    expect((result[2] as { content: string }).content).toBe("keep this");
  });
});
