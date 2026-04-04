/**
 * Model-facing prompt for the Grep tool.
 * Adapted from claude-code's GrepTool/prompt.ts.
 */

export const GREP_PROMPT = `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with the glob parameter (e.g., "*.js", "**/*.tsx")
- Returns matching lines with file paths and line numbers
- Use the Agent tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) — literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, pass a context_lines parameter.
`;
