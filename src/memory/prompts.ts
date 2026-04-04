/**
 * Prompt helpers for the memory system.
 *
 * `buildMemorySystemPromptSection` generates the instruction block injected
 * into the system prompt that teaches the model about the four-type memory
 * taxonomy and how to read/write memories.
 *
 * `buildExtractionPrompt` generates the user message sent to the LLM when
 * auto-extracting memories from a completed conversation turn.
 *
 * Both are adapted from claude-code's memdir/memoryTypes prompt helpers,
 * stripped of analytics, team memory, and Anthropic-specific concerns.
 */

const MEMORY_TYPES_SECTION = `## Memory types

Memories fall into exactly four types:

### user
Facts about the user: their role, expertise, communication preferences, how they like to collaborate, preferred tools and workflows.
Examples: "Senior backend engineer, prefers Rust", "Wants concise answers, no pleasantries"

### feedback
Corrections, praise, or behavioral guidance the user has given you. These shape how you work in future conversations.
Examples: "User said: stop adding unnecessary comments", "User prefers small focused commits"

### project
Context about the codebase or project that is NOT derivable from the code itself: architecture decisions and their rationale, deployment processes, external dependencies, team conventions.
Examples: "Auth service migrating from JWT to session tokens — decision made 2025-01", "CI runs on GitHub Actions, deploy via Vercel"

### reference
Pointers to external resources the user has shared: documentation links, dashboard URLs, API references, Slack channels.
Examples: "Design system docs: https://design.example.com", "Incident runbook in Notion"`;

const WHAT_NOT_TO_SAVE = `## What NOT to save

Do not save memories that are:
- Derivable from the code itself (file structure, function signatures, import patterns)
- Ephemeral to the current conversation (temporary debugging steps, in-progress plans)
- Redundant with an existing memory (check first, update instead of creating duplicates)
- Generic programming knowledge (how promises work, what REST means)`;

const WHEN_TO_ACCESS = `## When to access memories

Read your memories at the start of a conversation to orient yourself. During a conversation, consult them when:
- The user references something from a past conversation
- You need context about the project that isn't in the code
- You're about to make a decision that past feedback might inform
- The user asks "do you remember…" or similar`;

const HOW_TO_SAVE = `## How to save memories

Saving a memory is a two-step process:

**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) using this frontmatter format:

\`\`\`
---
name: short descriptive title
description: one-line summary
type: user | project | feedback | reference
---

Full content here…
\`\`\`

**Step 2** — add a pointer to that file in \`MEMORY.md\`. \`MEMORY.md\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`MEMORY.md\`.

- \`MEMORY.md\` is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.`;

/**
 * Build the system-prompt section that teaches the model about its persistent
 * memory directory.
 *
 * @param indexContent - The current contents of MEMORY.md (may be empty).
 * @param memoryDir   - Absolute path to the memory directory.
 */
export function buildMemorySystemPromptSection(
  indexContent: string,
  memoryDir: string,
): string {
  const sections: string[] = [
    "# Persistent Memory",
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    MEMORY_TYPES_SECTION,
    "",
    WHAT_NOT_TO_SAVE,
    "",
    HOW_TO_SAVE,
    "",
    WHEN_TO_ACCESS,
    "",
    "## MEMORY.md",
    "",
  ];

  if (indexContent.trim()) {
    sections.push(indexContent);
  } else {
    sections.push(
      "Your MEMORY.md is currently empty. When you save new memories, they will appear here.",
    );
  }

  return sections.join("\n");
}

/**
 * Build the prompt sent to the LLM to extract durable memories from a
 * conversation. The response should be a JSON object with a `memories` array.
 */
export function buildExtractionPrompt(
  conversationSummary: string,
  existingIndex: string,
): string {
  return `You are a memory extraction assistant. Analyze the following conversation and extract any information worth remembering for future conversations.

## Current memory index

${existingIndex.trim() || "(empty)"}

## Conversation

${conversationSummary}

## Instructions

Extract memories that fall into these categories:
- **user**: Facts about the user (role, preferences, expertise, communication style)
- **feedback**: Corrections or behavioral guidance the user gave the assistant
- **project**: Non-obvious project context (architecture decisions, deployment processes, conventions)
- **reference**: External links or resources the user shared

Do NOT extract:
- Information derivable from the code itself
- Ephemeral conversation details (debugging steps, temporary plans)
- Generic programming knowledge
- Information already captured in the existing memory index

If a memory should update an existing entry rather than creating a new one, use the "update" action and provide the existing path.

Respond with a JSON object:
{
  "memories": [
    {
      "name": "short descriptive title",
      "description": "one-line summary",
      "type": "user | project | feedback | reference",
      "content": "full memory content",
      "action": "create | update | delete",
      "path": "existing_file.md (required for update/delete, omit for create)"
    }
  ]
}

If there is nothing worth extracting, respond with: { "memories": [] }`;
}
