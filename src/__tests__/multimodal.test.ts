import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ChatMessage,
  ContentPart,
  UserMessage,
  ToolResultMessage,
} from "../session/types.js";
import type { ChatStreamChunk, ChatParams } from "../providers/types.js";
import {
  normalizeContent,
  contentToString,
  hasImageContent,
  stripImageContent,
} from "../utils/content.js";
import { estimateMessageTokens } from "../utils/tokens.js";
import { MockFs, MockAIProvider, textResponse } from "./helpers.js";
import { SessionStorage } from "../session/storage.js";
import { compactConversation } from "../compact/compact.js";
import { microcompactMessages } from "../compact/microcompact.js";

// ---------------------------------------------------------------------------
// Content utility helpers
// ---------------------------------------------------------------------------

describe("normalizeContent", () => {
  it("wraps a string as a single TextContent block", () => {
    const result = normalizeContent("hello");
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("returns ContentPart[] as-is", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "look at this" },
      { type: "image", data: "abc123", media_type: "image/png" },
    ];
    expect(normalizeContent(parts)).toBe(parts);
  });
});

describe("contentToString", () => {
  it("returns string content as-is", () => {
    expect(contentToString("hello")).toBe("hello");
  });

  it("concatenates text parts from ContentPart[]", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "first " },
      { type: "image", data: "abc", media_type: "image/png" },
      { type: "text", text: "second" },
    ];
    expect(contentToString(parts)).toBe("first second");
  });

  it("returns empty string for image-only content", () => {
    const parts: ContentPart[] = [
      { type: "image", data: "abc", media_type: "image/png" },
    ];
    expect(contentToString(parts)).toBe("");
  });
});

describe("hasImageContent", () => {
  it("returns false for string content", () => {
    expect(hasImageContent("hello")).toBe(false);
  });

  it("returns false for text-only parts", () => {
    expect(hasImageContent([{ type: "text", text: "hello" }])).toBe(false);
  });

  it("returns true for base64 image", () => {
    expect(
      hasImageContent([{ type: "image", data: "abc", media_type: "image/png" }]),
    ).toBe(true);
  });

  it("returns true for image URL", () => {
    expect(
      hasImageContent([{ type: "image_url", url: "https://example.com/img.png" }]),
    ).toBe(true);
  });
});

describe("stripImageContent", () => {
  it("returns string content unchanged", () => {
    expect(stripImageContent("hello")).toBe("hello");
  });

  it("returns text-only parts unchanged", () => {
    const parts: ContentPart[] = [{ type: "text", text: "hello" }];
    expect(stripImageContent(parts)).toBe(parts);
  });

  it("replaces images with placeholder", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "look:" },
      { type: "image", data: "abc", media_type: "image/png" },
    ];
    const result = stripImageContent(parts);
    expect(result).toEqual([
      { type: "text", text: "look:" },
      { type: "text", text: "[image removed]" },
    ]);
  });

  it("collapses to string when only one text part remains", () => {
    const parts: ContentPart[] = [
      { type: "image", data: "abc", media_type: "image/png" },
    ];
    expect(stripImageContent(parts)).toBe("[image removed]");
  });

  it("uses custom placeholder", () => {
    const parts: ContentPart[] = [
      { type: "image_url", url: "https://example.com/img.png" },
    ];
    expect(stripImageContent(parts, "[img stripped]")).toBe("[img stripped]");
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("estimateMessageTokens with multimodal", () => {
  it("estimates text-only messages same as before", () => {
    const tokens = estimateMessageTokens({ role: "user", content: "abcdefgh" });
    expect(tokens).toBe(2 + 4); // 8 chars / 4 = 2, + 4 overhead
  });

  it("adds ~85 tokens per image block", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "look:" },
      { type: "image", data: "abc", media_type: "image/png" },
    ];
    const tokens = estimateMessageTokens({ role: "user", content: parts });
    // "look:" = 5 chars -> ceil(5/4)=2 text tokens + 85 image tokens + 4 overhead
    expect(tokens).toBe(2 + 85 + 4);
  });

  it("counts multiple images", () => {
    const parts: ContentPart[] = [
      { type: "image", data: "a", media_type: "image/png" },
      { type: "image_url", url: "https://example.com/x.png" },
    ];
    const tokens = estimateMessageTokens({ role: "user", content: parts });
    expect(tokens).toBe(85 + 85 + 4);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: string content still works everywhere
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("UserMessage with string content is valid", () => {
    const msg: UserMessage = { role: "user", content: "hello" };
    expect(msg.content).toBe("hello");
  });

  it("UserMessage with ContentPart[] is valid", () => {
    const msg: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this:" },
        { type: "image", data: "base64data", media_type: "image/jpeg" },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it("ToolResultMessage with string content is valid", () => {
    const msg: ToolResultMessage = {
      role: "tool",
      tool_call_id: "tc1",
      content: "file contents here",
    };
    expect(msg.content).toBe("file contents here");
  });

  it("ToolResultMessage with ContentPart[] is valid", () => {
    const msg: ToolResultMessage = {
      role: "tool",
      tool_call_id: "tc1",
      content: [
        { type: "text", text: "screenshot:" },
        { type: "image", data: "screenshotdata", media_type: "image/png" },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compaction strips images
// ---------------------------------------------------------------------------

describe("compaction with images", () => {
  let fs: MockFs;
  let storage: SessionStorage;
  let provider: MockAIProvider;

  beforeEach(() => {
    fs = new MockFs();
    storage = new SessionStorage(fs, "/sessions");
    provider = new MockAIProvider();
  });

  it("strips image content from messages before summarizing", async () => {
    provider.addResponse(textResponse("Summary of conversation."));

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image", data: "iVBOR...longbase64...", media_type: "image/png" },
        ],
      },
      { role: "assistant", content: "It shows a cat." },
    ];

    const result = await compactConversation(
      provider,
      "mock-model",
      messages,
      storage,
      "s1",
      { stripBinaryContent: true },
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("[Conversation Summary]");

    // Verify the AI was NOT sent the raw image data
    const sentMessages = provider.calls[0].messages;
    for (const msg of sentMessages) {
      const text = contentToString(msg.content as string | ContentPart[]);
      expect(text).not.toContain("iVBOR...longbase64...");
    }
  });
});

// ---------------------------------------------------------------------------
// Provider message conversion (unit-level, via mock)
// ---------------------------------------------------------------------------

describe("OpenAI provider multimodal messages", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("converts ContentPart[] user messages to OpenAI format", async () => {
    const mockCreate = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          id: "c1",
          model: "gpt-4o",
          choices: [{ index: 0, delta: { content: "I see a cat" }, finish_reason: null }],
        };
        yield {
          id: "c2",
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })(),
    );

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", data: "base64data", media_type: "image/png" },
        ],
      },
    ];

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of provider.chat({ model: "gpt-4o", messages })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);

    // Verify the messages passed to OpenAI API contain image_url format
    const sentMessages = mockCreate.mock.calls[0][0].messages;
    const userMsg = sentMessages.find(
      (m: Record<string, unknown>) => m.role === "user",
    );
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(userMsg.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,base64data" },
    });
  });

  it("converts image_url ContentPart to OpenAI format", async () => {
    const mockCreate = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          id: "c1",
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })(),
    );

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image_url", url: "https://example.com/cat.jpg" },
        ],
      },
    ];

    for await (const _ of provider.chat({ model: "gpt-4o", messages })) {
      // consume
    }

    const sentMessages = mockCreate.mock.calls[0][0].messages;
    const userMsg = sentMessages.find(
      (m: Record<string, unknown>) => m.role === "user",
    );
    expect(userMsg.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.com/cat.jpg" },
    });
  });

  it("passes string user messages unchanged", async () => {
    const mockCreate = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          id: "c1",
          model: "gpt-4o",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      })(),
    );

    vi.doMock("openai", () => ({
      default: class {
        chat = { completions: { create: mockCreate } };
      },
    }));

    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ apiKey: "test-key" });

    const messages: ChatMessage[] = [
      { role: "user", content: "just text" },
    ];

    for await (const _ of provider.chat({ model: "gpt-4o", messages })) {
      // consume
    }

    const sentMessages = mockCreate.mock.calls[0][0].messages;
    const userMsg = sentMessages.find(
      (m: Record<string, unknown>) => m.role === "user",
    );
    expect(userMsg.content).toBe("just text");
  });
});

// ---------------------------------------------------------------------------
// Session persistence round-trip
// ---------------------------------------------------------------------------

describe("session storage with multimodal messages", () => {
  it("round-trips ContentPart[] messages through JSONL", async () => {
    const fs = new MockFs();
    const storage = new SessionStorage(fs, "/sessions");

    const userMsg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this:" },
        { type: "image", data: "base64data", media_type: "image/jpeg" },
      ],
    };

    await storage.appendMessage("s1", userMsg);
    await storage.appendMessage("s1", {
      role: "assistant",
      content: "It's a photo.",
    });

    const loaded = await storage.loadMessages("s1");
    expect(loaded).toHaveLength(2);

    const loadedUser = loaded[0] as UserMessage;
    expect(Array.isArray(loadedUser.content)).toBe(true);
    const parts = loadedUser.content as ContentPart[];
    expect(parts[0]).toEqual({ type: "text", text: "describe this:" });
    expect(parts[1]).toEqual({
      type: "image",
      data: "base64data",
      media_type: "image/jpeg",
    });
  });
});
