import type { Tool, ToolResult, ToolContext } from "./types.js";
import { WEB_FETCH_PROMPT } from "./prompts/web-fetch.js";

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_REDIRECTS = 5;

export function isPrivateHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }

  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) return true;
  if (hostname === "::1") return true;

  return false;
}

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

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { content: `Invalid URL: ${url}`, isError: true };
    }

    if (isPrivateHost(parsedUrl.hostname)) {
      return { content: `Blocked: "${parsedUrl.hostname}" resolves to a private/internal address`, isError: true };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let currentUrl = url;
      let response: Response | undefined;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "noumen-agent/1.0",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
          },
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const redirectUrl = new URL(location, currentUrl);
          if (isPrivateHost(redirectUrl.hostname)) {
            clearTimeout(timeoutId);
            return { content: `Blocked: redirect to private/internal address "${redirectUrl.hostname}"`, isError: true };
          }
          currentUrl = redirectUrl.toString();
          continue;
        }
        break;
      }

      clearTimeout(timeoutId);

      if (!response || !response.ok) {
        return {
          content: `HTTP ${response?.status ?? "unknown"}: ${response?.statusText ?? "no response"}`,
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

      // Stream the body with a size cap to avoid OOM when Content-Length is absent
      let text = "";
      let bytesRead = 0;
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          if (bytesRead > MAX_CONTENT_LENGTH) {
            reader.cancel();
            return {
              content: `Response too large (>${MAX_CONTENT_LENGTH} bytes streamed, limit ${MAX_CONTENT_LENGTH})`,
              isError: true,
            };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await response.text();
      }

      let markdown: string;
      if (contentType.includes("text/html") || contentType.includes("xhtml")) {
        const { NodeHtmlMarkdown } = await import("node-html-markdown");
        markdown = NodeHtmlMarkdown.translate(text);
      } else {
        markdown = text;
      }

      if (markdown.length > MAX_OUTPUT_CHARS) {
        const totalChars = markdown.length;
        markdown = markdown.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n... content truncated (${totalChars} total chars)`;
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
