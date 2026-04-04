/**
 * Model-facing prompt for the EditFile tool.
 * Adapted from claude-code's FileEditTool/prompt.ts.
 */

export const EDIT_PROMPT = `Performs exact string replacements in files.

Usage:
- You must use the ReadFile tool at least once before editing a file. This tool will error if you attempt an edit without reading the file first.
- When editing text from ReadFile output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + pipe. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
`;
