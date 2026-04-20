/**
 * CLI-facing provider resolver.
 *
 * Builds an `AiSdkProvider` wrapping any Vercel AI SDK `LanguageModelV3`.
 * Each vendor SDK is dynamically imported so CLI users only need to install
 * the packages for the providers they actually use.
 *
 * Programmatic callers should prefer constructing `AiSdkProvider` directly
 * with their own language model — that path supports metering proxies,
 * bespoke auth, and any other knob the AI SDK exposes. This resolver exists
 * so `noumen <provider>` still works out of the box.
 */

import type { AIProvider } from "./types.js";
import type { AiSdkLanguageModel } from "./ai-sdk/provider.js";
import { AiSdkProvider } from "./ai-sdk/provider.js";

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

function cannotFindVendor(provider: string, pkg: string, err: unknown): never {
  const hint =
    err instanceof Error && err.message.includes("Cannot find")
      ? ` Install it with \`pnpm add ${pkg}\`.`
      : "";
  throw new Error(
    `noumen provider "${provider}" requires the "${pkg}" package.${hint}`,
    { cause: err },
  );
}

async function loadModule<T = unknown>(
  provider: string,
  pkg: string,
): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    cannotFindVendor(provider, pkg, err);
  }
}

/**
 * Resolve a provider from a name string or pass through an AIProvider instance.
 *
 * API key resolution order:
 * 1. Explicit `apiKey` option
 * 2. Provider-specific env var (`OPENAI_API_KEY`, etc.)
 * 3. `NOUMEN_API_KEY` generic env var
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

  const apiKey =
    opts?.apiKey ??
    getProviderEnvKey(name) ??
    process.env.NOUMEN_API_KEY;

  const modelId = opts?.model ?? DEFAULT_MODELS[name];

  switch (name) {
    case "openai": {
      if (!apiKey) {
        throw new Error("OpenAI requires an API key. Set OPENAI_API_KEY or pass apiKey.");
      }
      const mod = await loadModule<{
        createOpenAI: (o: Record<string, unknown>) => ((id: string) => AiSdkLanguageModel) & {
          chat(id: string): AiSdkLanguageModel;
        };
      }>(name, "@ai-sdk/openai");
      const openai = mod.createOpenAI({ apiKey, baseURL: opts?.baseURL });
      // Pin to chat/completions — it's the lowest-common-denominator endpoint
      // and matches what the legacy OpenAIProvider used.
      return new AiSdkProvider({ model: openai.chat(modelId) });
    }

    case "anthropic": {
      if (!apiKey) {
        throw new Error("Anthropic requires an API key. Set ANTHROPIC_API_KEY or pass apiKey.");
      }
      const mod = await loadModule<{
        createAnthropic: (o: Record<string, unknown>) => (id: string) => AiSdkLanguageModel;
      }>(name, "@ai-sdk/anthropic");
      const anthropic = mod.createAnthropic({ apiKey, baseURL: opts?.baseURL });
      return new AiSdkProvider({
        model: anthropic(modelId),
        providerFamily: "anthropic",
        cacheConfig: { enabled: true },
      });
    }

    case "gemini": {
      if (!apiKey) {
        throw new Error("Gemini requires an API key. Set GEMINI_API_KEY or pass apiKey.");
      }
      const mod = await loadModule<{
        createGoogleGenerativeAI: (o: Record<string, unknown>) => (id: string) => AiSdkLanguageModel;
      }>(name, "@ai-sdk/google");
      const google = mod.createGoogleGenerativeAI({ apiKey, baseURL: opts?.baseURL });
      return new AiSdkProvider({ model: google(modelId), providerFamily: "google" });
    }

    case "openrouter": {
      if (!apiKey) {
        throw new Error("OpenRouter requires an API key. Set OPENROUTER_API_KEY or pass apiKey.");
      }
      const mod = await loadModule<{
        createOpenRouter: (o: Record<string, unknown>) => {
          chat(id: string): AiSdkLanguageModel;
        };
      }>(name, "@openrouter/ai-sdk-provider");
      const openrouter = mod.createOpenRouter({ apiKey });
      return new AiSdkProvider({ model: openrouter.chat(modelId) });
    }

    case "bedrock": {
      const mod = await loadModule<{
        createAmazonBedrock: (o: Record<string, unknown>) => (id: string) => AiSdkLanguageModel;
      }>(name, "@ai-sdk/amazon-bedrock");
      const bedrock = mod.createAmazonBedrock({
        region: process.env.AWS_REGION,
        baseURL: opts?.baseURL,
      });
      return new AiSdkProvider({ model: bedrock(modelId), providerFamily: "anthropic" });
    }

    case "vertex": {
      const mod = await loadModule<{
        createVertex: (o: Record<string, unknown>) => {
          anthropic(id: string): AiSdkLanguageModel;
        } & ((id: string) => AiSdkLanguageModel);
      }>(name, "@ai-sdk/google-vertex");
      const vertex = mod.createVertex({
        project: process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
        baseURL: opts?.baseURL,
      });
      // Default vertex usage is Claude via Anthropic-on-Vertex; the
      // DEFAULT_MODELS[vertex] id is a Claude id. If the caller passed a
      // Gemini model we route through the native Vertex Gemini entry.
      const isClaude = modelId.toLowerCase().includes("claude");
      const model = isClaude ? vertex.anthropic(modelId) : vertex(modelId);
      return new AiSdkProvider({
        model,
        providerFamily: isClaude ? "anthropic" : "google",
      });
    }

    case "ollama": {
      const mod = await loadModule<{
        createOllama: (o: Record<string, unknown>) => (id: string) => AiSdkLanguageModel;
      }>(name, "ollama-ai-provider-v2");
      const base =
        opts?.baseURL ??
        (process.env.OLLAMA_HOST
          ? `${process.env.OLLAMA_HOST.replace(/\/+$/, "")}/api`
          : undefined);
      const ollama = mod.createOllama(base ? { baseURL: base } : {});
      return new AiSdkProvider({ model: ollama(modelId) });
    }

    default:
      throw new Error(`Unhandled provider: ${name satisfies never}`);
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
