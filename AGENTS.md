# Agent Instructions for noumen

## Documentation Synchronization Rules

This repository has **four documentation surfaces** that must stay in sync with the implementation. When you change the public API, update **all** of them:

| Surface | Path | Scope |
|---------|------|-------|
| **README** | `README.md` | Full library overview, quick-start examples, feature summaries |
| **Docs site** | `website/docs/**/*.mdx` | Detailed per-feature documentation |
| **Docs intro** | `website/docs/index.mdx` | Landing page for docs site — feature cards and quick-start snippet |
| **Home page** | `website/src/app/page.tsx` | Marketing site — `FEATURES` array, hero copy, CTA blocks |

## When to update docs

Run this checklist **every time** you modify any of the files listed below:

### If you change `src/code.ts` (CodeOptions)
- Update `README.md` Options section
- Update `website/docs/getting-started/index.mdx` Code constructor examples
- Update the specific feature's docs page (e.g., if you add a new option for compaction, update `website/docs/compaction/index.mdx`)

### If you add/remove/rename a provider (`src/providers/*.ts`)
- Update `README.md` Providers section
- Update `website/docs/providers/index.mdx` (card list, description counts)
- Create or update the provider's dedicated docs page in `website/docs/providers/`
- Update `website/docs/getting-started/index.mdx` provider tabs
- Update `website/src/app/page.tsx` FEATURES array (provider count in "Six providers, one interface")
- Update `website/docs/index.mdx` provider descriptions

### If you add/remove/rename a tool (`src/tools/*.ts`)
- Update `README.md` Built-in Tools section
- Update `website/docs/tools/index.mdx` tool reference tables
- Update `website/docs/getting-started/index.mdx` if it references tool counts

### If you add/remove/rename a stream event (`src/session/types.ts` StreamEvent)
- Update `README.md` Stream Events table
- Update `website/docs/stream-events/index.mdx` event reference

### If you add/remove/rename a sandbox factory (`src/virtual/sandbox.ts`)
- Update `README.md` Sandboxes section
- Update `website/docs/virtual/index.mdx`
- Update `website/src/app/page.tsx` FEATURES array (sandbox count in "Four sandbox backends")

### If you change RunOptions (`src/session/types.ts`)
- Update `website/docs/stream-events/index.mdx` RunOptions table

### If you change hooks events (`src/hooks/types.ts`)
- Update `README.md` Hooks section
- Update `website/docs/hooks/index.mdx` event table
- Update `website/docs/embedding/index.mdx` if hook examples are affected

### If you add/change presets (`src/presets.ts`)
- Update `README.md` Presets section
- Update `website/docs/getting-started/index.mdx` preset quick-start
- Update `website/docs/embedding/index.mdx` preset examples

### If you add/change the server/client API (`src/server/index.ts`, `src/client/index.ts`)
- Update `website/docs/embedding/index.mdx` server/client examples

### If you change permission modes (`src/permissions/types.ts`)
- Update `README.md` Permissions section
- Update `website/docs/permissions/index.mdx` modes table

### If you change CLI flags or config shape (`src/cli/*.ts`)
- Update `README.md` CLI section (flags table, config example)
- Update `website/docs/cli/index.mdx` (flags reference, config keys table)

## Code example rules

- **Always use the `sandbox` pattern** in documentation examples:
  ```typescript
  const code = new Code({
    aiProvider,
    sandbox: LocalSandbox({ cwd: "/my/project" }),
    options: { ... },
  });
  ```
- **Never use the deprecated `virtualFs` / `virtualComputer` pattern** in any docs or README. These fields exist for backward compatibility only.
- **Import providers from subpaths**, not from the main barrel:
  ```typescript
  import { OpenAIProvider } from "noumen/openai";     // correct
  import { OpenAIProvider } from "noumen";              // wrong — providers are not re-exported from main
  ```
- **Import sandbox factories and Code from the main barrel**:
  ```typescript
  import { Code, LocalSandbox } from "noumen";
  ```

## Counts to keep accurate

These numeric claims appear in multiple places. Grep for them when changing the relevant code:

- **Provider count** — currently 7 (OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, Vertex, Ollama)
- **Core tool count** — currently 9 (ReadFile, WriteFile, EditFile, Bash, Glob, Grep, WebFetch, NotebookEdit, AskUser)
- **Sandbox backend count** — currently 4 (Local, Sprites, Docker, E2B)
- **Hook event count** — currently 18 (PreToolUse, PostToolUse, PostToolUseFailure, TurnStart, TurnEnd, SessionStart, SessionEnd, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, FileWrite, ModelSwitch, RetryAttempt, MemoryUpdate, Error)
- **Permission mode count** — currently 6 (default, plan, acceptEdits, auto, bypassPermissions, dontAsk)

## MCP config format

`mcpServers` is a `Record<string, McpServerConfig>`, **not** an array. Correct:
```typescript
mcpServers: {
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
}
```

## LSP config format

`lsp` is a `Record<string, LspServerConfig>`, **not** an `enableLsp` boolean + `lspServers` array. Correct:
```typescript
lsp: {
  typescript: { command: "typescript-language-server", args: ["--stdio"], fileExtensions: [".ts", ".tsx"] },
}
```

## Stream event field names

- `text_delta` and `thinking_delta` events use `event.text`, **not** `event.content`.

## Testing

When making documentation changes, verify the docs site builds:
```bash
cd website && pnpm build
```
