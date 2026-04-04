import type { Tool, ToolResult, ToolContext } from "./types.js";
import { WEB_FETCH_PROMPT } from "./prompts/web-fetch.js";

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;

export const webFetchTool: Tool = {
  name: "WebFetch",
  description:
    "Fetch a URL and return its contents as markdown. Useful for reading " +
    "web pages, documentation, API responses, and other online content. " +
    "Provide an optional prompt to extract specific information.",
  prompt: WEB_FETCH_PROMPT,
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must be a valid http/https URL)",
      },
      prompt: {
        type: "string",
        description:
          "Optional instruction for what to extract from the page content",
      },
    },
    required: ["url"],
  },

  async call(
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const url = args.url as string;
    const prompt = args.prompt as string | undefined;

    try {
      new URL(url);
    } catch {
      return { content: `Invalid URL: ${url}`, isError: true };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "noumen-agent/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
        redirect: "follow",
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          content: `HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = parseInt(
        response.headers.get("content-length") ?? "0",
        10,
      );

      if (contentLength > MAX_CONTENT_LENGTH) {
        return {
          content: `Response too large (${contentLength} bytes, limit ${MAX_CONTENT_LENGTH})`,
          isError: true,
        };
      }

      const text = await response.text();

      let markdown: string;
      if (contentType.includes("text/html") || contentType.includes("xhtml")) {
        const { NodeHtmlMarkdown } = await import("node-html-markdown");
        markdown = NodeHtmlMarkdown.translate(text);
      } else {
        markdown = text;
      }

      if (markdown.length > MAX_OUTPUT_CHARS) {
        markdown = markdown.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n... content truncated (${markdown.length} total chars)`;
      }

      let result = `# Content from ${url}\n\n${markdown}`;
      if (prompt) {
        result = `## Extraction prompt: ${prompt}\n\n${result}`;
      }

      return { content: result };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { content: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms`, isError: true };
      }
      return {
        content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
