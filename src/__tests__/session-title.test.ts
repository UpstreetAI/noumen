import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockFs, MockAIProvider, textChunk, stopChunk } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import {
  extractTitleSeedText,
  extractTitleFromResponse,
  normalizeTitle,
  generateAutoTitle,
} from "../session/auto-title.js";
import type { ChatStreamChunk } from "../providers/types.js";

let fs: MockFs;
let storage: SessionStorage;

beforeEach(() => {
  fs = new MockFs();
  storage = new SessionStorage(fs, "/sessions");
});

describe("SessionStorage title APIs", () => {
  it("appendCustomTitle + getSessionTitles round-trip", async () => {
    await storage.appendCustomTitle("s1", "My Session");
    const t = await storage.getSessionTitles("s1");
    expect(t.customTitle).toBe("My Session");
    expect(t.aiTitle).toBeUndefined();
    expect(t.title).toBe("My Session");
  });

  it("appendAiTitle + getSessionTitles round-trip", async () => {
    await storage.appendAiTitle("s1", "Fix login bug");
    const t = await storage.getSessionTitles("s1");
    expect(t.aiTitle).toBe("Fix login bug");
    expect(t.customTitle).toBeUndefined();
    expect(t.title).toBe("Fix login bug");
  });

  it("custom-title wins over ai-title regardless of write order", async () => {
    await storage.appendAiTitle("s1", "Ai generated");
    await storage.appendCustomTitle("s1", "User picked");

    const afterUserThenAi = await storage.getSessionTitles("s1");
    expect(afterUserThenAi.title).toBe("User picked");

    await storage.appendAiTitle("s1", "Ai generated v2");
    const afterLaterAi = await storage.getSessionTitles("s1");
    expect(afterLaterAi.customTitle).toBe("User picked");
    expect(afterLaterAi.aiTitle).toBe("Ai generated v2");
    expect(afterLaterAi.title).toBe("User picked");
  });

  it("last custom-title wins among multiple custom-titles", async () => {
    await storage.appendCustomTitle("s1", "First");
    await storage.appendCustomTitle("s1", "Second");
    await storage.appendCustomTitle("s1", "Third");
    const t = await storage.getSessionTitles("s1");
    expect(t.customTitle).toBe("Third");
    expect(t.title).toBe("Third");
  });

  it("getSessionTitles returns empty object for missing session", async () => {
    const t = await storage.getSessionTitles("nope");
    expect(t).toEqual({ title: undefined, customTitle: undefined, aiTitle: undefined });
  });

  it("listSessions surfaces both titles and prefers custom", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hello" });
    await storage.appendAiTitle("s1", "Ai title");
    await storage.appendCustomTitle("s1", "Custom title");

    await storage.appendMessage("s2", { role: "user", content: "hello" });
    await storage.appendAiTitle("s2", "Only ai");

    const sessions = await storage.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "s1");
    const s2 = sessions.find((s) => s.sessionId === "s2");
    expect(s1?.customTitle).toBe("Custom title");
    expect(s1?.aiTitle).toBe("Ai title");
    expect(s1?.title).toBe("Custom title");
    expect(s2?.customTitle).toBeUndefined();
    expect(s2?.aiTitle).toBe("Only ai");
    expect(s2?.title).toBe("Only ai");
  });

  it("deleteSession removes the transcript", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    expect(await storage.sessionExists("s1")).toBe(true);
    await storage.deleteSession("s1");
    expect(await storage.sessionExists("s1")).toBe(false);
  });

  it("deleteSession is a no-op for missing sessions", async () => {
    await expect(storage.deleteSession("nope")).resolves.toBeUndefined();
  });

  it("reAppendMetadataAfterCompact preserves both title entries", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendCustomTitle("s1", "User title");
    await storage.appendAiTitle("s1", "Ai title");
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    await storage.reAppendMetadataAfterCompact("s1");

    const entries = await storage.loadAllEntries("s1");
    const boundaryIdx = entries.findIndex((e) => e.type === "compact-boundary");
    const afterBoundary = entries.slice(boundaryIdx + 1);
    const customAfter = afterBoundary.find((e) => e.type === "custom-title");
    const aiAfter = afterBoundary.find((e) => e.type === "ai-title");
    expect(customAfter).toBeDefined();
    expect(aiAfter).toBeDefined();
    expect((customAfter as { title: string }).title).toBe("User title");
    expect((aiAfter as { title: string }).title).toBe("Ai title");
  });

  it("reAppendMetadataAfterCompact preserves metadata keys", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendMetadata("s1", "k1", "v1");
    await storage.appendMetadata("s1", "k2", { nested: true });
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    await storage.reAppendMetadataAfterCompact("s1");

    const entries = await storage.loadAllEntries("s1");
    const boundaryIdx = entries.findIndex((e) => e.type === "compact-boundary");
    const metadataAfter = entries
      .slice(boundaryIdx + 1)
      .filter((e) => e.type === "metadata") as Array<{
        key: string;
        value: unknown;
      }>;
    const byKey = new Map(metadataAfter.map((m) => [m.key, m.value]));
    expect(byKey.get("k1")).toBe("v1");
    expect(byKey.get("k2")).toEqual({ nested: true });
  });

  it("reAppendMetadataAfterCompact uses the latest value when a key changed", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendMetadata("s1", "k", "first");
    await storage.appendMetadata("s1", "k", "latest");
    await storage.appendCompactBoundary("s1");
    await storage.appendSummary("s1", { role: "user", content: "summary" });

    await storage.reAppendMetadataAfterCompact("s1");

    const entries = await storage.loadAllEntries("s1");
    const boundaryIdx = entries.findIndex((e) => e.type === "compact-boundary");
    const metadataAfter = entries
      .slice(boundaryIdx + 1)
      .filter((e) => e.type === "metadata") as Array<{ key: string; value: unknown }>;
    expect(metadataAfter).toHaveLength(1);
    expect(metadataAfter[0].value).toBe("latest");
  });

  it("reAppendMetadataAfterCompact is a no-op when there is nothing to re-emit", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    const before = await storage.loadAllEntries("s1");
    await storage.reAppendMetadataAfterCompact("s1");
    const after = await storage.loadAllEntries("s1");
    expect(after).toHaveLength(before.length);
  });

  it("titles survive multiple compact cycles", async () => {
    await storage.appendMessage("s1", { role: "user", content: "hi" });
    await storage.appendCustomTitle("s1", "User title");
    await storage.appendAiTitle("s1", "Ai title v1");

    for (let i = 0; i < 3; i++) {
      await storage.appendCompactBoundary("s1");
      await storage.appendSummary("s1", {
        role: "user",
        content: `summary ${i}`,
      });
      await storage.reAppendMetadataAfterCompact("s1");
    }

    const titles = await storage.getSessionTitles("s1");
    expect(titles.customTitle).toBe("User title");
    expect(titles.aiTitle).toBe("Ai title v1");
    expect(titles.title).toBe("User title");

    const sessions = await storage.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "s1");
    expect(s1?.title).toBe("User title");
    expect(s1?.customTitle).toBe("User title");
    expect(s1?.aiTitle).toBe("Ai title v1");
  });
});

describe("auto-title helpers", () => {
  describe("extractTitleSeedText", () => {
    it("flattens user + assistant string content", () => {
      const seed = extractTitleSeedText([
        { role: "user", content: "fix login button" },
        { role: "assistant", content: "sure, on it" },
      ]);
      expect(seed).toContain("fix login button");
      expect(seed).toContain("sure, on it");
    });

    it("skips tool + system messages", () => {
      const seed = extractTitleSeedText([
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "ship the fix" },
        { role: "tool", tool_call_id: "t1", content: "done" },
      ]);
      expect(seed).toBe("ship the fix");
    });

    it("extracts text parts from content arrays", () => {
      const seed = extractTitleSeedText([
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: "ignored", media_type: "image/png" },
          ],
        },
      ]);
      expect(seed).toBe("look at this");
    });

    it("tail-slices when over the cap so recent context wins", () => {
      const longUser = "x".repeat(5_000) + " RECENT";
      const seed = extractTitleSeedText(
        [{ role: "user", content: longUser }],
        100,
      );
      expect(seed.length).toBe(100);
      expect(seed.endsWith("RECENT")).toBe(true);
    });

    it("returns empty string for no usable content", () => {
      expect(extractTitleSeedText([])).toBe("");
      expect(
        extractTitleSeedText([{ role: "assistant", content: "" }]),
      ).toBe("");
    });
  });

  describe("extractTitleFromResponse", () => {
    it("pulls title from a JSON object", () => {
      expect(
        extractTitleFromResponse('{"title": "Fix login button"}'),
      ).toBe("Fix login button");
    });

    it("handles prose-wrapped JSON", () => {
      expect(
        extractTitleFromResponse(
          'Here is the title:\n\n{"title": "Add OAuth"}\n\ndone',
        ),
      ).toBe("Add OAuth");
    });

    it("handles escaped quotes", () => {
      expect(
        extractTitleFromResponse('{"title": "He said \\"hi\\""}'),
      ).toBe('He said "hi"');
    });

    it("decodes \\n, \\t, and \\\\ through JSON.parse", () => {
      expect(
        extractTitleFromResponse('{"title": "Line one\\nLine two"}'),
      ).toBe("Line one\nLine two");
      expect(
        extractTitleFromResponse('{"title": "Tab\\there"}'),
      ).toBe("Tab\there");
      expect(
        extractTitleFromResponse('{"title": "Back\\\\slash"}'),
      ).toBe("Back\\slash");
    });

    it("decodes unicode escapes through JSON.parse", () => {
      expect(
        extractTitleFromResponse('{"title": "caf\\u00e9 order"}'),
      ).toBe("café order");
    });

    it("falls back to a quoted substring", () => {
      expect(extractTitleFromResponse('Here is "Ship the fix" maybe')).toBe(
        "Ship the fix",
      );
    });

    it("returns null on empty / unusable input", () => {
      expect(extractTitleFromResponse("")).toBeNull();
      expect(extractTitleFromResponse("no structure at all")).toBeNull();
    });

    it("returns null when the JSON 'title' field is empty or non-string", () => {
      expect(extractTitleFromResponse('{"title": ""}')).toBeNull();
      expect(extractTitleFromResponse('{"title": 42}')).toBeNull();
    });
  });

  describe("normalizeTitle", () => {
    it("collapses whitespace", () => {
      expect(normalizeTitle("  Fix   the\nbug  ")).toBe("Fix the bug");
    });

    it("strips wrapping quotes and trailing period", () => {
      expect(normalizeTitle('"Fix the bug."')).toBe("Fix the bug");
    });

    it("strips multiple trailing periods", () => {
      expect(normalizeTitle("Fix the bug...")).toBe("Fix the bug");
    });

    it("strips wrapping single quotes", () => {
      expect(normalizeTitle("'Fix the bug'")).toBe("Fix the bug");
    });

    it("clamps overlong titles", () => {
      const long = "word ".repeat(200);
      const result = normalizeTitle(long);
      expect(result).not.toBeNull();
      expect(result!.length).toBeLessThanOrEqual(120);
    });

    it("returns null on empty", () => {
      expect(normalizeTitle("")).toBeNull();
      expect(normalizeTitle('""')).toBeNull();
      expect(normalizeTitle("   ")).toBeNull();
    });
  });

  describe("generateAutoTitle", () => {
    // generateAutoTitle intentionally warns on every soft failure so callers
    // aren't left in the dark. Silence the warnings inside this block — the
    // two tests that assert on them create their own explicit spies below.
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function titleResponse(json: string): ChatStreamChunk[] {
      return [textChunk(json), stopChunk()];
    }

    it("returns null when seed text is empty", async () => {
      const provider = new MockAIProvider([titleResponse('{"title": "x"}')]);
      const t = await generateAutoTitle([], {
        provider,
        model: "mock-model",
      });
      expect(t).toBeNull();
      expect(provider.calls).toHaveLength(0);
    });

    it("returns null when no model is available", async () => {
      const provider = new MockAIProvider();
      (provider as { defaultModel: string | undefined }).defaultModel =
        undefined;
      const t = await generateAutoTitle(
        [{ role: "user", content: "hi" }],
        { provider },
      );
      expect(t).toBeNull();
      expect(provider.calls).toHaveLength(0);
    });

    it("queries the provider and returns the cleaned title", async () => {
      const provider = new MockAIProvider([
        titleResponse('{"title": "Fix login button"}'),
      ]);
      const t = await generateAutoTitle(
        [
          { role: "user", content: "the login button does not respond" },
          { role: "assistant", content: "I'll look at the event handler" },
        ],
        { provider, model: "mock-model" },
      );
      expect(t).toBe("Fix login button");
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].model).toBe("mock-model");
      expect(provider.calls[0].system).toContain("sentence-case title");
      expect(provider.calls[0].outputFormat?.type).toBe("json_schema");
    });

    it("sends reasoning-safe defaults so reasoning/thinking models don't burn the budget on internal tokens", async () => {
      // This is the guardrail that keeps the title round-trip cheap on
      // OpenAI GPT-5 / o-series (reasoningEffort: "minimal") and on
      // Gemini 2.5-flash (thinking: disabled). Providers that don't
      // recognise the fields ignore them, so this is safe for everyone.
      const provider = new MockAIProvider([
        titleResponse('{"title": "Ship the fix"}'),
      ]);
      await generateAutoTitle(
        [{ role: "user", content: "ship the fix" }],
        { provider, model: "mock-model" },
      );
      const [call] = provider.calls;
      expect(call.reasoningEffort).toBe("minimal");
      expect(call.thinking).toEqual({ type: "disabled" });
      // 60 was the old cap — must be materially higher so reasoning
      // models have room to emit their JSON after thinking.
      expect(call.max_tokens).toBeGreaterThanOrEqual(256);
    });

    it("returns null when the provider throws", async () => {
      const provider = new MockAIProvider();
      const t = await generateAutoTitle(
        [{ role: "user", content: "hi" }],
        { provider, model: "mock-model" },
      );
      expect(t).toBeNull();
    });

    it("surfaces provider errors via console.warn so callers aren't left in the dark", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const provider = new MockAIProvider();
        const t = await generateAutoTitle(
          [{ role: "user", content: "hi" }],
          { provider, model: "mock-model" },
        );
        expect(t).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, payload] = warn.mock.calls[0] as [string, { model: string; message: string }];
        expect(label).toMatch(/auto-title/);
        expect(payload.model).toBe("mock-model");
        expect(payload.message).toMatch(/no more responses/);
      } finally {
        warn.mockRestore();
      }
    });

    it("logs when the provider streams no content so silent null-titles are debuggable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const provider = new MockAIProvider([[textChunk(""), stopChunk()]]);
        const t = await generateAutoTitle(
          [{ role: "user", content: "hi" }],
          { provider, model: "mock-model" },
        );
        expect(t).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, payload] = warn.mock.calls[0] as [string, { model: string }];
        expect(label).toMatch(/no content/);
        expect(payload.model).toBe("mock-model");
      } finally {
        warn.mockRestore();
      }
    });

    it("uses provider.defaultModel when no model is given", async () => {
      const provider = new MockAIProvider([
        titleResponse('{"title": "Investigate cache miss"}'),
      ]);
      (provider as { defaultModel?: string }).defaultModel = "default-123";
      const t = await generateAutoTitle(
        [{ role: "user", content: "cache miss rate went up" }],
        { provider },
      );
      expect(t).toBe("Investigate cache miss");
      expect(provider.calls[0].model).toBe("default-123");
    });

    it("returns null when the provider only emits thinking deltas (no content)", async () => {
      // Some providers stream thinking blocks without any content delta.
      // We want to bail rather than pretend to have parsed a title.
      const thinkingChunk: ChatStreamChunk = {
        id: "mock-thinking",
        model: "mock-model",
        choices: [
          {
            index: 0,
            delta: { thinking_content: "pondering..." },
            finish_reason: null,
          },
        ],
      };
      const provider = new MockAIProvider([[thinkingChunk, stopChunk()]]);
      const t = await generateAutoTitle(
        [{ role: "user", content: "hello" }],
        { provider, model: "mock-model" },
      );
      expect(t).toBeNull();
    });

    it("returns null when the provider yields an empty string", async () => {
      const provider = new MockAIProvider([[textChunk(""), stopChunk()]]);
      const t = await generateAutoTitle(
        [{ role: "user", content: "hello" }],
        { provider, model: "mock-model" },
      );
      expect(t).toBeNull();
    });
  });
});
