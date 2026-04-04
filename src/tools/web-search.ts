import type { Tool, ToolResult, ToolContext } from "./types.js";
import { getWebSearchPrompt } from "./prompts/web-search.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchConfig {
  search: (query: string, domains?: string[]) => Promise<WebSearchResult[]>;
}

/**
 * Create a WebSearch tool backed by a user-provided search implementation.
 * This keeps noumen provider-agnostic — plug in Tavily, SerpAPI, Brave Search, etc.
 *
 * @example
 * ```ts
 * const webSearch = createWebSearchTool({
 *   search: async (query) => {
 *     const res = await tavily.search({ query });
 *     return res.results.map(r => ({ title: r.title, url: r.url, snippet: r.content }));
 *   },
 * });
 * ```
 */
export function createWebSearchTool(config: WebSearchConfig): Tool {
  return {
    name: "WebSearch",
    description:
      "Search the web for real-time information. Returns titles, URLs, and " +
      "snippets from search results. Use when you need up-to-date information " +
      "not available in the local codebase.",
    prompt: getWebSearchPrompt,
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        domains: {
          type: "string",
          description:
            "Comma-separated list of domains to restrict search to (e.g. 'docs.python.org,stackoverflow.com')",
        },
      },
      required: ["query"],
    },

    async call(
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      const query = args.query as string;
      const domainsRaw = args.domains as string | undefined;
      const domains = domainsRaw
        ? domainsRaw.split(",").map((d) => d.trim()).filter(Boolean)
        : undefined;

      try {
        const results = await config.search(query, domains);

        if (results.length === 0) {
          return { content: "No search results found." };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`,
          )
          .join("\n\n");

        return { content: `Search results for: ${query}\n\n${formatted}` };
      } catch (err) {
        return {
          content: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Default WebSearch tool that returns a helpful error when no search provider
 * is configured. Register this as a placeholder; consumers should replace
 * it with `createWebSearchTool(config)`.
 */
export const webSearchToolPlaceholder: Tool = {
  name: "WebSearch",
  description: "Search the web (requires configuration — see noumen docs).",
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  },

  async call(): Promise<ToolResult> {
    return {
      content:
        "WebSearch is not configured. Provide a search implementation " +
        "via AgentOptions.options.webSearch or createWebSearchTool().",
      isError: true,
    };
  },
};
