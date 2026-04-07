import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtractMemoriesResult } from "../memory/extraction.js";

const mockExtract = vi.fn<(...args: unknown[]) => Promise<ExtractMemoriesResult>>();
vi.mock("../memory/extraction.js", () => ({
  extractMemories: (...args: unknown[]) => mockExtract(...args),
}));

import {
  MockFs,
  MockComputer,
  MockAIProvider,
  textResponse,
} from "./helpers.js";
import { Thread } from "../thread.js";
import type { ThreadConfig } from "../thread.js";
import type { StreamEvent } from "../session/types.js";
import type { MemoryProvider, MemoryEntry } from "../memory/types.js";
import { createAutoCompactConfig } from "../compact/auto-compact.js";

let fs: MockFs;
let computer: MockComputer;
let provider: MockAIProvider;
let baseConfig: ThreadConfig;

function mockMemoryProvider(): MemoryProvider {
  return {
    loadIndex: vi.fn().mockResolvedValue(""),
    loadEntry: vi.fn().mockResolvedValue(null),
    saveEntry: vi.fn().mockResolvedValue(undefined),
    removeEntry: vi.fn().mockResolvedValue(undefined),
    listEntries: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fs = new MockFs();
  computer = new MockComputer();
  provider = new MockAIProvider();
  baseConfig = {
    provider,
    fs,
    computer,
    sessionDir: "/sessions",
    autoCompact: createAutoCompactConfig({ enabled: false }),
  };
});

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("Memory extraction epilogue", () => {
  it("emits memory_update event when extraction finds changes", async () => {
    const memProvider = mockMemoryProvider();
    const created: MemoryEntry = {
      name: "user-pref",
      description: "User prefers TypeScript",
      type: "user",
      content: "The user prefers TypeScript over JavaScript.",
    };

    mockExtract.mockResolvedValue({
      created: [created],
      updated: [],
      deleted: [],
    });

    provider.addResponse(textResponse("Noted."));

    const config: ThreadConfig = {
      ...baseConfig,
      memory: {
        provider: memProvider,
        autoExtract: true,
      },
    };

    const thread = new Thread(config, { sessionId: "mem-extract" });
    const events = await collectEvents(thread.run("I prefer TypeScript"));

    const memEvents = events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(1);
    expect((memEvents[0] as any).created).toHaveLength(1);
    expect((memEvents[0] as any).created[0].name).toBe("user-pref");
    expect((memEvents[0] as any).updated).toHaveLength(0);
    expect((memEvents[0] as any).deleted).toHaveLength(0);
  });

  it("does not emit memory_update when extraction finds no changes", async () => {
    mockExtract.mockResolvedValue({
      created: [],
      updated: [],
      deleted: [],
    });

    provider.addResponse(textResponse("OK."));

    const config: ThreadConfig = {
      ...baseConfig,
      memory: {
        provider: mockMemoryProvider(),
        autoExtract: true,
      },
    };

    const thread = new Thread(config, { sessionId: "mem-no-change" });
    const events = await collectEvents(thread.run("hello"));

    const memEvents = events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(0);
  });

  it("completes the run even when extraction throws (best-effort)", async () => {
    mockExtract.mockRejectedValue(new Error("LLM extraction failed"));

    provider.addResponse(textResponse("Done."));

    const config: ThreadConfig = {
      ...baseConfig,
      memory: {
        provider: mockMemoryProvider(),
        autoExtract: true,
      },
    };

    const thread = new Thread(config, { sessionId: "mem-error" });
    const events = await collectEvents(thread.run("do something"));

    // Run should complete normally despite extraction failure
    const turnComplete = events.find((e) => e.type === "turn_complete");
    expect(turnComplete).toBeDefined();

    const memEvents = events.filter((e) => e.type === "memory_update");
    expect(memEvents).toHaveLength(0);

    // No error event for the memory extraction failure
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
  });

  it("does not run extraction when autoExtract is false", async () => {
    provider.addResponse(textResponse("Hi."));

    const config: ThreadConfig = {
      ...baseConfig,
      memory: {
        provider: mockMemoryProvider(),
        autoExtract: false,
      },
    };

    const thread = new Thread(config, { sessionId: "mem-disabled" });
    await collectEvents(thread.run("hello"));

    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("fires MemoryUpdate hook when extraction has changes", async () => {
    const hookFn = vi.fn();
    const created: MemoryEntry = {
      name: "proj-info",
      description: "Project uses Vitest",
      type: "project",
      content: "This project uses Vitest for testing.",
    };

    mockExtract.mockResolvedValue({
      created: [created],
      updated: [],
      deleted: ["old-entry-id"],
    });

    provider.addResponse(textResponse("Got it."));

    const config: ThreadConfig = {
      ...baseConfig,
      memory: {
        provider: mockMemoryProvider(),
        autoExtract: true,
      },
      hooks: [{ event: "MemoryUpdate", handler: hookFn }],
    };

    const thread = new Thread(config, { sessionId: "mem-hook" });
    await collectEvents(thread.run("we use vitest"));

    expect(hookFn).toHaveBeenCalledTimes(1);
    const input = hookFn.mock.calls[0][0];
    expect(input.event).toBe("MemoryUpdate");
    expect(input.entries).toHaveLength(2); // 1 created + 1 deleted
  });
});
