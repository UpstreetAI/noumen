import type { Tool, ToolResult, ToolContext, ToolParameters } from "./types.js";

export const TOOL_SEARCH_NAME = "ToolSearch";

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 *
 * A tool is deferred if:
 * - It has `shouldDefer: true`
 * - It's an MCP tool (has `mcpInfo`) and doesn't have `alwaysLoad: true`
 *
 * A tool is never deferred if it has `alwaysLoad: true`, or if it IS
 * the ToolSearch tool itself.
 */
export function isDeferredTool(tool: Tool): boolean {
  if ((tool as ToolWithDeferral).alwaysLoad === true) return false;
  if (tool.mcpInfo !== undefined) return true;
  if (tool.name === TOOL_SEARCH_NAME) return false;
  return (tool as ToolWithDeferral).shouldDefer === true;
}

/**
 * Format a single deferred tool as a one-line reference for the system prompt.
 */
export function formatDeferredToolLine(tool: Tool): string {
  const desc = tool.description.split(".")[0];
  return `- ${tool.name}: ${desc}`;
}

/**
 * Parse a tool name into searchable parts. Handles MCP tools (mcp__server__action)
 * and CamelCase tool names.
 */
function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  if (name.startsWith("mcp__") || name.includes("__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    const parts = withoutPrefix.split("__").flatMap((p) => p.split("_"));
    return { parts: parts.filter(Boolean), full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "), isMcp: true };
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return { parts, full: parts.join(" "), isMcp: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keyword search over tool names and descriptions.
 */
export function searchToolsWithKeywords(
  query: string,
  deferredTools: Tool[],
  allTools: Tool[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim();

  const exactMatch =
    deferredTools.find((t) => t.name.toLowerCase() === queryLower) ??
    allTools.find((t) => t.name.toLowerCase() === queryLower);
  if (exactMatch) return [exactMatch.name];

  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];

  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;

  const termPatterns = new Map<string, RegExp>();
  for (const term of allScoringTerms) {
    if (!termPatterns.has(term)) {
      termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }

  let candidates = deferredTools;
  if (requiredTerms.length > 0) {
    candidates = deferredTools.filter((tool) => {
      const parsed = parseToolName(tool.name);
      const descLower = tool.description.toLowerCase();
      return requiredTerms.every((term) => {
        const pattern = termPatterns.get(term)!;
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some((part) => part.includes(term)) ||
          pattern.test(descLower)
        );
      });
    });
  }

  const scored = candidates.map((tool) => {
    const parsed = parseToolName(tool.name);
    const descLower = tool.description.toLowerCase();
    let score = 0;

    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!;

      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10;
      } else if (parsed.parts.some((part) => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5;
      }

      if (parsed.full.includes(term) && score === 0) {
        score += 3;
      }

      if (pattern.test(descLower)) {
        score += 2;
      }
    }

    return { name: tool.name, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.name);
}

/**
 * Format matched tool schemas as a `<functions>` block for the model.
 */
function formatToolSchemas(tools: Tool[]): string {
  if (tools.length === 0) return "No matching deferred tools found.";

  const lines = tools.map((t) => {
    const schema = {
      description: t.description,
      name: t.name,
      parameters: t.parameters,
    };
    return `<function>${JSON.stringify(schema)}</function>`;
  });

  return `<functions>\n${lines.join("\n")}\n</functions>`;
}

/**
 * Extended Tool interface with deferral properties.
 */
export interface ToolWithDeferral extends Tool {
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
}

/**
 * Create the ToolSearch tool. Requires access to the tool registry for
 * looking up deferred tools and their schemas.
 */
export function createToolSearchTool(
  getDeferredTools: () => Tool[],
  getAllTools: () => Tool[],
  getToolsByNames: (names: string[]) => Tool[],
  onDiscovered: (names: string[]) => void,
): Tool {
  return {
    name: TOOL_SEARCH_NAME,
    description:
      "Fetches full schema definitions for deferred tools so they can be called. " +
      "Deferred tools appear by name in <available-deferred-tools> sections. " +
      "Until fetched, only the name is known — there is no parameter schema, " +
      "so the tool cannot be invoked. Use this tool to load tool schemas.\n\n" +
      "Query forms:\n" +
      '- "select:Read,Edit,Grep" — fetch these exact tools by name\n' +
      '- "notebook jupyter" — keyword search, up to max_results best matches\n' +
      '- "+slack send" — require "slack" in the name, rank by remaining terms',
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
        },
      },
      required: ["query"],
    } satisfies ToolParameters,

    async call(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const maxResults = (args.max_results as number | undefined) ?? 5;
      const deferredTools = getDeferredTools();
      const allTools = getAllTools();

      const selectMatch = query.match(/^select:(.+)$/i);
      if (selectMatch) {
        const requested = selectMatch[1]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        const found: string[] = [];
        for (const toolName of requested) {
          const match =
            deferredTools.find((t) => t.name.toLowerCase() === toolName.toLowerCase()) ??
            allTools.find((t) => t.name.toLowerCase() === toolName.toLowerCase());
          if (match && !found.includes(match.name)) {
            found.push(match.name);
          }
        }

        if (found.length === 0) {
          return {
            content: JSON.stringify({
              matches: [],
              query,
              total_deferred_tools: deferredTools.length,
            }),
          };
        }

        onDiscovered(found);
        const matchedTools = getToolsByNames(found);
        return { content: formatToolSchemas(matchedTools) };
      }

      const matches = searchToolsWithKeywords(query, deferredTools, allTools, maxResults);

      if (matches.length === 0) {
        return {
          content: JSON.stringify({
            matches: [],
            query,
            total_deferred_tools: deferredTools.length,
          }),
        };
      }

      onDiscovered(matches);
      const matchedTools = getToolsByNames(matches);
      return { content: formatToolSchemas(matchedTools) };
    },
  };
}
