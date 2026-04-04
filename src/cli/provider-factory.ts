export {
  resolveProvider as createProvider,
  detectProvider,
  type ProviderName,
  SUPPORTED_PROVIDERS,
  DEFAULT_MODELS,
} from "../providers/resolve.js";

export type { ResolveProviderOptions as ProviderOptions } from "../providers/resolve.js";

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaBaseURL()}/api/tags`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function ollamaBaseURL(): string {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  return host.replace(/\/+$/, "");
}
