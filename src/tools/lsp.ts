import type { Tool } from "./types.js";
import type { LspLocation, LspSymbol } from "../lsp/types.js";

export const lspTool: Tool = {
  name: "LSP",
  description:
    "Query language servers for code intelligence. Supports: goToDefinition, " +
    "findReferences, hover, documentSymbol, workspaceSymbol. " +
    "Line and character are 1-based.",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "The LSP operation to perform",
        enum: [
          "goToDefinition",
          "findReferences",
          "hover",
          "documentSymbol",
          "workspaceSymbol",
        ],
      },
      filePath: {
        type: "string",
        description: "Absolute path to the file (required for all except workspaceSymbol)",
      },
      line: {
        type: "number",
        description: "1-based line number (required for definition/references/hover)",
        minimum: 1,
      },
      character: {
        type: "number",
        description: "1-based character offset (required for definition/references/hover)",
        minimum: 1,
      },
      query: {
        type: "string",
        description: "Search query for workspaceSymbol (optional, empty = all)",
      },
    },
    required: ["operation"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(args, ctx) {
    if (!ctx.lspManager) {
      return { content: "LSP is not configured.", isError: true };
    }
    if (!ctx.lspManager.isConnected()) {
      return { content: "No LSP servers are connected.", isError: true };
    }

    const op = args.operation as string;
    const filePath = args.filePath as string | undefined;
    const line = (args.line as number | undefined) ?? 1;
    const character = (args.character as number | undefined) ?? 1;

    try {
      switch (op) {
        case "goToDefinition": {
          if (!filePath) return { content: "filePath is required for goToDefinition", isError: true };
          const result = await ctx.lspManager.sendRequest<LspLocationResult | LspLocationResult[]>(
            filePath,
            "textDocument/definition",
            {
              textDocument: { uri: `file://${filePath}` },
              position: { line: line - 1, character: character - 1 },
            },
          );
          return { content: formatLocations("Definition", result) };
        }

        case "findReferences": {
          if (!filePath) return { content: "filePath is required for findReferences", isError: true };
          const result = await ctx.lspManager.sendRequest<LspLocationResult[]>(
            filePath,
            "textDocument/references",
            {
              textDocument: { uri: `file://${filePath}` },
              position: { line: line - 1, character: character - 1 },
              context: { includeDeclaration: true },
            },
          );
          return { content: formatLocations("References", result) };
        }

        case "hover": {
          if (!filePath) return { content: "filePath is required for hover", isError: true };
          const result = await ctx.lspManager.sendRequest<{ contents: string | { value: string } | Array<string | { value: string }> } | null>(
            filePath,
            "textDocument/hover",
            {
              textDocument: { uri: `file://${filePath}` },
              position: { line: line - 1, character: character - 1 },
            },
          );
          if (!result) return { content: "No hover information available." };
          return { content: formatHover(result.contents) };
        }

        case "documentSymbol": {
          if (!filePath) return { content: "filePath is required for documentSymbol", isError: true };
          const result = await ctx.lspManager.sendRequest<LspDocumentSymbol[]>(
            filePath,
            "textDocument/documentSymbol",
            { textDocument: { uri: `file://${filePath}` } },
          );
          return { content: formatDocumentSymbols(result) };
        }

        case "workspaceSymbol": {
          const query = (args.query as string) ?? "";
          const firstFile = filePath ?? "";
          const result = await ctx.lspManager.sendRequest<LspWorkspaceSymbol[]>(
            firstFile,
            "workspace/symbol",
            { query },
          );
          return { content: formatWorkspaceSymbols(result) };
        }

        default:
          return { content: `Unknown LSP operation: ${op}`, isError: true };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `LSP error: ${message}`, isError: true };
    }
  },
};

interface LspLocationResult {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: { start: { line: number; character: number } };
  children?: LspDocumentSymbol[];
}

interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  location: { uri: string; range: { start: { line: number; character: number } } };
  containerName?: string;
}

function formatLocations(
  label: string,
  result: LspLocationResult | LspLocationResult[] | null,
): string {
  if (!result) return `${label}: No results found.`;
  const arr = Array.isArray(result) ? result : [result];
  if (arr.length === 0) return `${label}: No results found.`;

  const lines = arr.map((loc) => {
    const path = loc.uri.replace("file://", "");
    return `  ${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  });
  return `${label} (${arr.length} result${arr.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
}

function formatHover(
  contents: string | { value: string } | Array<string | { value: string }>,
): string {
  if (typeof contents === "string") return contents;
  if ("value" in contents) return contents.value;
  return contents
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n\n");
}

function formatDocumentSymbols(
  symbols: LspDocumentSymbol[] | null,
  indent = 0,
): string {
  if (!symbols || symbols.length === 0) return "No symbols found.";
  const prefix = "  ".repeat(indent);
  return symbols
    .map((s) => {
      const line = `${prefix}${symbolKindName(s.kind)} ${s.name} (line ${s.range.start.line + 1})`;
      if (s.children?.length) {
        return line + "\n" + formatDocumentSymbols(s.children, indent + 1);
      }
      return line;
    })
    .join("\n");
}

function formatWorkspaceSymbols(symbols: LspWorkspaceSymbol[] | null): string {
  if (!symbols || symbols.length === 0) return "No symbols found.";
  return symbols
    .slice(0, 100)
    .map((s) => {
      const path = s.location.uri.replace("file://", "");
      const loc = `${path}:${s.location.range.start.line + 1}`;
      const container = s.containerName ? ` (in ${s.containerName})` : "";
      return `  ${symbolKindName(s.kind)} ${s.name}${container} — ${loc}`;
    })
    .join("\n");
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] ?? `Kind(${kind})`;
}
