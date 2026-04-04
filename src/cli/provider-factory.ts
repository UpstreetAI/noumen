import type { AIProvider } from "../providers/types.js";

const ENV_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-opus-4.6",
  gemini: "gemini-2.5-flash",
  openrouter: "anthropic/claude-opus-4.6",
  bedrock: "us.anthropic.claude-opus-4.6-v1:0",
  vertex: "claude-opus-4.6",
  ollama: "qwen2.5-coder:32b",
};

const SUPPORTED_PROVIDERS = Object.keys(DEFAULT_MODELS);

function getProviderEnvKey(name: string): string | undefined {
  const envVar = ENV_KEY_MAP[name];
  return envVar ? process.env[envVar] : undefined;
}

/**
 * Auto-detect provider from available environment variables.
 * Checks cloud providers first, then probes for a local Ollama server.
 */
export async function detectProvider(): Promise<string | undefined> {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return "bedrock";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCLOUD_PROJECT) return "vertex";

  if (process.env.OLLAMA_HOST) return "ollama";

  if (await isOllamaRunning()) return "ollama";

  return undefined;
}

function ollamaBaseURL(): string {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  return host.replace(/\/+$/, "");
}

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaBaseURL()}/api/tags`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ProviderOptions {
  apiKey?: string;
  model?: string;
  configApiKey?: string;
  baseURL?: string;
}

/**
 * Construct an AIProvider by name. API key resolution order:
 * 1. Explicit apiKey (--api-key flag)
 * 2. Provider-specific env var (OPENAI_API_KEY, etc.)
 * 3. NOUMEN_API_KEY generic env var
 * 4. Config file apiKey
 */
export async function createProvider(
  name: string,
  opts: ProviderOptions,
): Promise<AIProvider> {
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    throw new Error(
      `Unknown provider "${name}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  const key =
    opts.apiKey ??
    getProviderEnvKey(name) ??
    process.env.NOUMEN_API_KEY ??
    opts.configApiKey;

  switch (name) {
    case "openai": {
      if (!key) throw new Error("OpenAI requires an API key. Set OPENAI_API_KEY or use --api-key.");
      const { OpenAIProvider } = await import("../providers/openai.js");
      return new OpenAIProvider({ apiKey: key, model: opts.model, baseURL: opts.baseURL });
    }
    case "anthropic": {
      if (!key) throw new Error("Anthropic requires an API key. Set ANTHROPIC_API_KEY or use --api-key.");
      const { AnthropicProvider } = await import("../providers/anthropic.js");
      return new AnthropicProvider({ apiKey: key, model: opts.model });
    }
    case "gemini": {
      if (!key) throw new Error("Gemini requires an API key. Set GEMINI_API_KEY or use --api-key.");
      const { GeminiProvider } = await import("../providers/gemini.js");
      return new GeminiProvider({ apiKey: key, model: opts.model });
    }
    case "openrouter": {
      if (!key) throw new Error("OpenRouter requires an API key. Set OPENROUTER_API_KEY or use --api-key.");
      const { OpenRouterProvider } = await import("../providers/openrouter.js");
      return new OpenRouterProvider({ apiKey: key, model: opts.model, appName: "noumen" });
    }
    case "bedrock": {
      const { BedrockAnthropicProvider } = await import("../providers/bedrock.js");
      return new BedrockAnthropicProvider({ model: opts.model });
    }
    case "vertex": {
      const { VertexAnthropicProvider } = await import("../providers/vertex.js");
      return new VertexAnthropicProvider({ model: opts.model });
    }
    case "ollama": {
      const { OllamaProvider } = await import("../providers/ollama.js");
      const base = opts.baseURL ?? (process.env.OLLAMA_HOST
        ? `${process.env.OLLAMA_HOST.replace(/\/+$/, "")}/v1`
        : undefined);
      return new OllamaProvider({ model: opts.model, baseURL: base });
    }
    default:
      throw new Error(`Unhandled provider: ${name}`);
  }
}

export { SUPPORTED_PROVIDERS, DEFAULT_MODELS, isOllamaRunning, ollamaBaseURL };
