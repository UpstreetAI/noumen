/**
 * Model-facing prompt for the WebSearch tool.
 * Adapted from claude-code's WebSearchTool/prompt.ts.
 */

function getCurrentMonthYear(): string {
  const d = new Date();
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

export function getWebSearchPrompt(): string {
  const currentMonthYear = getCurrentMonthYear();
  return `Search the web for real-time information about any topic. Returns summarized information from search results and relevant URLs.

- Provides up-to-date information for current events and recent data
- Returns search result information including links as markdown hyperlinks
- Use this tool for accessing information beyond the model's knowledge cutoff

CRITICAL REQUIREMENT:
- After answering the user's question, you MUST include a "Sources:" section at the end of your response
- In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
- This is MANDATORY — never skip including sources in your response
- Example format:

  [Your answer here]

  Sources:
  - [Source Title 1](https://example.com/1)
  - [Source Title 2](https://example.com/2)

IMPORTANT — Use the correct year in search queries:
- The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
- Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year.
`;
}
