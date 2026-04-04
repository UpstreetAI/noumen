export interface FrontmatterData {
  "allowed-tools"?: string | string[] | null;
  description?: string | null;
  paths?: string | string[] | null;
  context?: "inline" | "fork" | null;
  "argument-hint"?: string | null;
  [key: string]: unknown;
}

export interface ParsedFrontmatter {
  frontmatter: FrontmatterData;
  body: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the parsed frontmatter fields and the body after the closing ---.
 * If no frontmatter is found, returns empty frontmatter and the full content as body.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = content.slice(match[0].length);

  let data = parseSimpleYaml(yamlBlock);

  if (data === null) {
    // Retry: quote values that contain YAML-special characters
    const quoted = yamlBlock.replace(
      /^(\s*[\w-]+\s*:\s*)(.+)$/gm,
      (_, prefix: string, value: string) => {
        const trimmed = value.trim();
        if (
          !trimmed.startsWith('"') &&
          !trimmed.startsWith("'") &&
          /[{}\[\],*&!|>%@`]/.test(trimmed)
        ) {
          return `${prefix}"${trimmed.replace(/"/g, '\\"')}"`;
        }
        return `${prefix}${value}`;
      },
    );
    data = parseSimpleYaml(quoted);
  }

  return { frontmatter: data ?? {}, body };
}

/**
 * Minimal YAML-subset parser for frontmatter.
 * Handles: key: value, key: [list], multi-line lists with - items.
 */
function parseSimpleYaml(yaml: string): FrontmatterData | null {
  try {
    const result: FrontmatterData = {};
    const lines = yaml.split("\n");
    let currentKey: string | null = null;
    let currentList: string[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Check for list item under current key
      const listItemMatch = trimmed.match(/^-\s+(.+)$/);
      if (listItemMatch && currentKey && currentList) {
        currentList.push(unquote(listItemMatch[1].trim()));
        continue;
      }

      // Flush any pending list
      if (currentKey && currentList) {
        result[currentKey] = currentList.length === 1 ? currentList[0] : currentList;
        currentKey = null;
        currentList = null;
      }

      // Key: value pair
      const kvMatch = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!kvMatch) continue;

      const key = kvMatch[1];
      const rawValue = kvMatch[2].trim();

      if (!rawValue) {
        // Could be followed by list items
        currentKey = key;
        currentList = [];
        continue;
      }

      // Inline array: [a, b, c]
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const inner = rawValue.slice(1, -1);
        result[key] = inner
          .split(",")
          .map((s) => unquote(s.trim()))
          .filter(Boolean);
        continue;
      }

      // Scalar value
      result[key] = unquote(rawValue);
    }

    // Flush trailing list
    if (currentKey && currentList) {
      result[currentKey] = currentList.length === 1 ? currentList[0] : currentList;
    }

    return result;
  } catch {
    return null;
  }
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse the allowed-tools field from frontmatter.
 * Accepts a string (comma/space separated), string[], or null/undefined.
 */
export function parseAllowedTools(
  value: string | string[] | null | undefined,
): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the paths field from frontmatter into glob patterns.
 */
export function parsePaths(
  value: string | string[] | null | undefined,
): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
