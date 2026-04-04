/**
 * Model-facing prompt for the WriteFile tool.
 * Adapted from claude-code's FileWriteTool/prompt.ts.
 */

export const WRITE_PROMPT = `Writes a file to the local filesystem. Parent directories are created automatically if they don't exist.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the ReadFile tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the EditFile tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
`;
