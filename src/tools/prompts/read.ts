/**
 * Model-facing prompt for the ReadFile tool.
 * Adapted from claude-code's FileReadTool/prompt.ts.
 */

export const READ_PROMPT = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path.
- By default, it reads the entire file. Use offset and limit to read specific portions of large files.
- Lines in the output are numbered with the format: LINE_NUMBER|LINE_CONTENT
- If you read a file that exists but has empty contents you will receive a notice in place of file contents.
- This tool can read image files (e.g. PNG, JPG) when the provider supports multimodal input.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs.
- This tool can only read files, not directories. To list a directory, use an ls command via the Bash tool.
- If the file has not changed since the last read, a "file_unchanged" result is returned to save context tokens.
`;
