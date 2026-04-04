/**
 * Normalize a server or tool name to be compatible with the API pattern
 * ^[a-zA-Z0-9_-]{1,64}$. Replaces any invalid characters with underscores.
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`;
}

export function buildMcpToolName(
  serverName: string,
  toolName: string,
): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`;
}

/**
 * Parse a fully-qualified MCP tool name back into server + tool components.
 * Returns null if the string doesn't match the mcp__server__tool pattern.
 */
export function parseMcpToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  const parts = fullName.split("__");
  const [prefix, serverName, ...toolParts] = parts;
  if (prefix !== "mcp" || !serverName) return null;
  const toolName = toolParts.length > 0 ? toolParts.join("__") : undefined;
  if (!toolName) return null;
  return { serverName, toolName };
}
