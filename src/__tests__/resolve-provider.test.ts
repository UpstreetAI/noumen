import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIProvider } from "../providers/types.js";

// We need fresh module state for each test because resolveProvider uses dynamic imports.
// We mock the individual provider modules at the top level.

const MockOpenAI = vi.fn();
const MockAnthropic = vi.fn();
const MockGemini = vi.fn();
const MockOpenRouter = vi.fn();
const MockBedrock = vi.fn();
const MockVertex = vi.fn();
const MockOllama = vi.fn();

vi.mock("../providers/openai.js", () => ({ OpenAIProvider: MockOpenAI }));
vi.mock("../providers/anthropic.js", () => ({ AnthropicProvider: MockAnthropic }));
vi.mock("../providers/gemini.js", () => ({ GeminiProvider: MockGemini }));
vi.mock("../providers/openrouter.js", () => ({ OpenRouterProvider: MockOpenRouter }));
vi.mock("../providers/bedrock.js", () => ({ BedrockAnthropicProvider: MockBedrock }));
vi.mock("../providers/vertex.js", () => ({ VertexAnthropicProvider: MockVertex }));
vi.mock("../providers/ollama.js", () => ({ OllamaProvider: MockOllama }));

import { resolveProvider, detectProvider, SUPPORTED_PROVIDERS } from "../providers/resolve.js";

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Clear all provider-related env vars
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.NOUMEN_API_KEY;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_PROFILE;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GCLOUD_PROJECT;
  delete process.env.OLLAMA_HOST;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveProvider", () => {
  it("passes through an AIProvider instance unchanged", async () => {
    const provider: AIProvider = { chat: vi.fn() as AIProvider["chat"] };
    const result = await resolveProvider(provider);
    expect(result).toBe(provider);
  });

  it("throws for unknown provider name", async () => {
    await expect(resolveProvider("unknown_provider" as any)).rejects.toThrow(
      /Unknown provider "unknown_provider"/,
    );
  });

  it("lists supported providers in the error", async () => {
    try {
      await resolveProvider("bad" as any);
    } catch (e: any) {
      for (const name of SUPPORTED_PROVIDERS) {
        expect(e.message).toContain(name);
      }
    }
  });

  describe("openai", () => {
    it("throws when no API key is available", async () => {
      await expect(resolveProvider("openai")).rejects.toThrow(/OpenAI requires an API key/);
    });

    it("resolves with explicit apiKey", async () => {
      await resolveProvider("openai", { apiKey: "sk-explicit", model: "gpt-4" });
      expect(MockOpenAI).toHaveBeenCalledWith({
        apiKey: "sk-explicit",
        model: "gpt-4",
        baseURL: undefined,
      });
    });

    it("falls back to OPENAI_API_KEY env var", async () => {
      process.env.OPENAI_API_KEY = "sk-env";
      await resolveProvider("openai");
      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-env" }),
      );
    });

    it("falls back to NOUMEN_API_KEY", async () => {
      process.env.NOUMEN_API_KEY = "sk-generic";
      await resolveProvider("openai");
      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-generic" }),
      );
    });

    it("opts.apiKey wins over env vars", async () => {
      process.env.OPENAI_API_KEY = "sk-env";
      process.env.NOUMEN_API_KEY = "sk-generic";
      await resolveProvider("openai", { apiKey: "sk-explicit" });
      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-explicit" }),
      );
    });

    it("forwards baseURL", async () => {
      await resolveProvider("openai", { apiKey: "k", baseURL: "http://custom" });
      expect(MockOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://custom" }),
      );
    });
  });

  describe("anthropic", () => {
    it("throws when no API key is available", async () => {
      await expect(resolveProvider("anthropic")).rejects.toThrow(/Anthropic requires an API key/);
    });

    it("passes cacheControl: { enabled: true }", async () => {
      await resolveProvider("anthropic", { apiKey: "sk-a" });
      expect(MockAnthropic).toHaveBeenCalledWith(
        expect.objectContaining({ cacheControl: { enabled: true } }),
      );
    });
  });

  describe("gemini", () => {
    it("throws when no API key is available", async () => {
      await expect(resolveProvider("gemini")).rejects.toThrow(/Gemini requires an API key/);
    });

    it("resolves with apiKey", async () => {
      await resolveProvider("gemini", { apiKey: "gk" });
      expect(MockGemini).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "gk" }),
      );
    });
  });

  describe("openrouter", () => {
    it("throws when no API key is available", async () => {
      await expect(resolveProvider("openrouter")).rejects.toThrow(/OpenRouter requires an API key/);
    });

    it("passes appName: 'noumen'", async () => {
      await resolveProvider("openrouter", { apiKey: "ork" });
      expect(MockOpenRouter).toHaveBeenCalledWith(
        expect.objectContaining({ appName: "noumen" }),
      );
    });
  });

  describe("bedrock", () => {
    it("resolves without an API key", async () => {
      await resolveProvider("bedrock", { model: "us.anthropic.claude-3" });
      expect(MockBedrock).toHaveBeenCalledWith(
        expect.objectContaining({ model: "us.anthropic.claude-3" }),
      );
    });
  });

  describe("vertex", () => {
    it("resolves without an API key", async () => {
      await resolveProvider("vertex", { baseURL: "https://custom" });
      expect(MockVertex).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://custom" }),
      );
    });
  });

  describe("ollama", () => {
    it("uses opts.baseURL directly", async () => {
      await resolveProvider("ollama", { baseURL: "http://my-host/v1" });
      expect(MockOllama).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://my-host/v1" }),
      );
    });

    it("constructs baseURL from OLLAMA_HOST with /v1 and trailing slash strip", async () => {
      process.env.OLLAMA_HOST = "http://remote:11434/";
      await resolveProvider("ollama");
      expect(MockOllama).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://remote:11434/v1" }),
      );
    });

    it("leaves baseURL undefined when no OLLAMA_HOST and no opts.baseURL", async () => {
      await resolveProvider("ollama");
      expect(MockOllama).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: undefined }),
      );
    });
  });
});

describe("detectProvider", () => {
  it("returns anthropic when ANTHROPIC_API_KEY is set (highest priority)", async () => {
    process.env.ANTHROPIC_API_KEY = "ak";
    process.env.OPENAI_API_KEY = "ok";
    expect(await detectProvider()).toBe("anthropic");
  });

  it("returns openai when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "ok";
    expect(await detectProvider()).toBe("openai");
  });

  it("returns gemini when only GEMINI_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "gk";
    expect(await detectProvider()).toBe("gemini");
  });

  it("returns openrouter when only OPENROUTER_API_KEY is set", async () => {
    process.env.OPENROUTER_API_KEY = "ork";
    expect(await detectProvider()).toBe("openrouter");
  });

  it("returns bedrock via AWS_ACCESS_KEY_ID", async () => {
    process.env.AWS_ACCESS_KEY_ID = "ak";
    expect(await detectProvider()).toBe("bedrock");
  });

  it("returns bedrock via AWS_PROFILE", async () => {
    process.env.AWS_PROFILE = "dev";
    expect(await detectProvider()).toBe("bedrock");
  });

  it("returns vertex via GOOGLE_APPLICATION_CREDENTIALS", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/path/creds.json";
    expect(await detectProvider()).toBe("vertex");
  });

  it("returns vertex via GCLOUD_PROJECT", async () => {
    process.env.GCLOUD_PROJECT = "my-project";
    expect(await detectProvider()).toBe("vertex");
  });

  it("returns ollama when OLLAMA_HOST is set", async () => {
    process.env.OLLAMA_HOST = "http://localhost:11434";
    expect(await detectProvider()).toBe("ollama");
  });

  it("returns ollama when fetch to localhost succeeds", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as any;
    try {
      expect(await detectProvider()).toBe("ollama");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns undefined when nothing is available and fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as any;
    try {
      expect(await detectProvider()).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
