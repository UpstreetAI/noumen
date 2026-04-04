/**
 * Model-facing prompt for the WebFetch tool.
 * Adapted from claude-code's WebFetchTool/prompt.ts.
 */

export const WEB_FETCH_PROMPT = `Fetches content from a specified URL and returns it in a readable format.

- Takes a URL and fetches the page content, converting HTML to markdown
- Returns the processed content for analysis
- Use this tool when you need to retrieve and analyze web content

Usage notes:
- The URL must be a fully-formed valid URL
- HTTP URLs will be automatically upgraded to HTTPS
- This tool is read-only and does not modify any files
- Results may be summarized if the content is very large
- When a URL redirects to a different host, the tool will inform you and provide the redirect URL. You should then make a new WebFetch request with the redirect URL.
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`;
