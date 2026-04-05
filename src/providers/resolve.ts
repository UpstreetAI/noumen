import type { AIProvider } from "./types.js";

export type ProviderName =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "ollama";

const ENV_KEY_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-opus-4.6",
  gemini: "gemini-2.5-flash",
  openrouter: "anthropic/claude-opus-4.6",
  bedrock: "us.anthropic.claude-opus-4.6-v1:0",
  vertex: "claude-opus-4.6",
  ollama: "qwen2.5-coder:32b",
};

export const SUPPORTED_PROVIDERS: ProviderName[] = Object.keys(DEFAULT_MODELS) as ProviderName[];

function getProviderEnvKey(name: string): string | undefined {
  const envVar = ENV_KEY_MAP[name];
  return envVar ? process.env[envVar] : undefined;
}

export interface ResolveProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * Resolve a provider from a name string or pass through an AIProvider instance.
 * API key resolution order:
 * 1. Explicit apiKey option
 * 2. Provider-specific env var (OPENAI_API_KEY, etc.)
 * 3. NOUMEN_API_KEY generic env var
 */
export async function resolveProvider(
  input: AIProvider | ProviderName,
  opts?: ResolveProviderOptions,
): Promise<AIProvider> {
  if (typeof input !== "string") return input;

  const name = input;
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    throw new Error(
      `Unknown provider "${name}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  const key =
    opts?.apiKey ??
    getProviderEnvKey(name) ??
    process.env.NOUMEN_API_KEY;

  switch (name) {
    case "openai": {
      if (!key) throw new Error("OpenAI requires an API key. Set OPENAI_API_KEY or pass apiKey.");
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider({ apiKey: key, model: opts?.model, baseURL: opts?.baseURL });
    }
    case "anthropic": {
      if (!key) throw new Error("Anthropic requires an API key. Set ANTHROPIC_API_KEY or pass apiKey.");
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider({ apiKey: key, model: opts?.model, baseURL: opts?.baseURL });
    }
    case "gemini": {
      if (!key) throw new Error("Gemini requires an API key. Set GEMINI_API_KEY or pass apiKey.");
      const { GeminiProvider } = await import("./gemini.js");
      return new GeminiProvider({ apiKey: key, model: opts?.model, baseURL: opts?.baseURL });
    }
    case "openrouter": {
      if (!key) throw new Error("OpenRouter requires an API key. Set OPENROUTER_API_KEY or pass apiKey.");
      const { OpenRouterProvider } = await import("./openrouter.js");
      return new OpenRouterProvider({ apiKey: key, model: opts?.model, appName: "noumen" });
    }
    case "bedrock": {
      const { BedrockAnthropicProvider } = await import("./bedrock.js");
      return new BedrockAnthropicProvider({ model: opts?.model, baseURL: opts?.baseURL });
    }
    case "vertex": {
      const { VertexAnthropicProvider } = await import("./vertex.js");
      return new VertexAnthropicProvider({ model: opts?.model });
    }
    case "ollama": {
      const { OllamaProvider } = await import("./ollama.js");
      const base = opts?.baseURL ?? (process.env.OLLAMA_HOST
        ? `${process.env.OLLAMA_HOST.replace(/\/+$/, "")}/v1`
        : undefined);
      return new OllamaProvider({ model: opts?.model, baseURL: base });
    }
    default:
      throw new Error(`Unhandled provider: ${name}`);
  }
}

/**
 * Auto-detect provider from available environment variables.
 */
export async function detectProvider(): Promise<ProviderName | undefined> {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return "bedrock";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCLOUD_PROJECT) return "vertex";
  if (process.env.OLLAMA_HOST) return "ollama";

  try {
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const res = await fetch(`${host.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) return "ollama";
  } catch { /* not running */ }

  return undefined;
}
