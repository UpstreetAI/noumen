import { OpenAIProvider } from "./openai.js";

export interface OllamaProviderOptions {
  /** Ollama server URL. Defaults to http://localhost:11434/v1. */
  baseURL?: string;
  model?: string;
}

export class OllamaProvider extends OpenAIProvider {
  constructor(opts: OllamaProviderOptions = {}) {
    super({
      baseURL: opts.baseURL ?? "http://localhost:11434/v1",
      model: opts.model ?? "qwen2.5-coder:32b",
    });
  }
}
