import * as dns from "node:dns";
import type { Tool, ToolResult, ToolContext } from "./types.js";
import { WEB_FETCH_PROMPT } from "./prompts/web-fetch.js";

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./, "");
}

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_REDIRECTS = 5;

export function isPrivateIP(ip: string): boolean {
  const stripped = ip.replace(/^\[|\]$/g, "");

  if (stripped === "::1" || stripped === "0.0.0.0" || stripped === "::") return true;

  if (stripped.startsWith("fe80:")) return true;

  const firstTwo = stripped.slice(0, 2).toLowerCase();
  if (firstTwo === "fc" || firstTwo === "fd") return true;

  if (stripped.toLowerCase().startsWith("::ffff:")) {
    const embedded = stripped.slice(7);
    return embedded.includes(".") ? isPrivateIP(embedded) : true;
  }

  const parts = stripped.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  return false;
}

export function isPrivateHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return true;
  }

  if (isPrivateIP(hostname)) return true;

  if (hostname.startsWith("fe80:") || hostname.startsWith("[fe80:")) return true;

  return false;
}

/**
 * Resolve a hostname via DNS and check that none of the resolved IPs are
 * private. Prevents DNS rebinding attacks where a public hostname resolves
 * to a loopback or RFC-1918 address.
 */
export async function checkDnsRebinding(hostname: string): Promise<string | null> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return isPrivateIP(hostname) ? hostname : null;
  }

  try {
    const addrs = await dns.promises.resolve4(hostname);
    for (const addr of addrs) {
      if (isPrivateIP(addr)) return addr;
    }
  } catch {
    // resolve4 failed — try resolve6
  }

  try {
    const addrs6 = await dns.promises.resolve6(hostname);
    for (const addr of addrs6) {
      if (isPrivateIP(addr)) return addr;
    }
  } catch {
    // no AAAA records either — allow (DNS may just not resolve yet)
  }

  return null;
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

    if (parsedUrl.username || parsedUrl.password) {
      return { content: `Blocked: URLs with embedded credentials are not allowed`, isError: true };
    }

    if (parsedUrl.protocol === "http:") {
      parsedUrl.protocol = "https:";
    }

    if (isPrivateHost(parsedUrl.hostname)) {
      return { content: `Blocked: "${parsedUrl.hostname}" resolves to a private/internal address`, isError: true };
    }

    const rebindIP = await checkDnsRebinding(parsedUrl.hostname);
    if (rebindIP) {
      return { content: `Blocked: "${parsedUrl.hostname}" resolves to private address ${rebindIP}`, isError: true };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let currentUrl = parsedUrl.toString();
      const originalHost = stripWww(parsedUrl.hostname);
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
          if (stripWww(redirectUrl.hostname) !== originalHost) {
            clearTimeout(timeoutId);
            return { content: `Blocked: redirect to different host "${redirectUrl.hostname}" (original: "${parsedUrl.hostname}")`, isError: true };
          }
          if (isPrivateHost(redirectUrl.hostname)) {
            clearTimeout(timeoutId);
            return { content: `Blocked: redirect to private/internal address "${redirectUrl.hostname}"`, isError: true };
          }
          const redirectRebind = await checkDnsRebinding(redirectUrl.hostname);
          if (redirectRebind) {
            clearTimeout(timeoutId);
            return { content: `Blocked: redirect target "${redirectUrl.hostname}" resolves to private address ${redirectRebind}`, isError: true };
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
