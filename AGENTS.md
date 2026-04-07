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

### If you change `src/agent.ts` (AgentOptions)
- Update `README.md` Options section
- Update `website/docs/getting-started/index.mdx` Agent constructor examples
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
- Update `website/src/app/page.tsx` FEATURES array (sandbox count in "Six sandbox backends")

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

### If you change `DiagnoseResult` or `diagnose()` (`src/agent.ts`)
- Update `README.md` health checks snippet (in Embedding section)
- Update `website/docs/embedding/index.mdx` health checks section
- Update `website/docs/cli/index.mdx` doctor command section
- Update `src/__tests__/presets.test.ts` diagnose tests

### If you change server routes or WS protocol (`src/server/index.ts`)
- Update `website/docs/server-api/index.mdx` (REST endpoints, WS messages, middleware)
- Update `website/docs/embedding/index.mdx` server/client examples

### If you change headless protocol (`src/cli/headless.ts`)
- Update `website/docs/cli/index.mdx` headless mode section
- Update `website/docs/server-api/index.mdx` headless CLI protocol section

## Code example rules

- **Prefer the string provider shorthand** for simple examples:
  ```typescript
  const agent = new Agent({ provider: "anthropic", cwd: "." });
  ```
- **Use the `sandbox` pattern** when showing explicit sandbox configuration:
  ```typescript
  const agent = new Agent({
    provider,
    sandbox: LocalSandbox({ cwd: "/my/project" }),
    options: { ... },
  });
  ```
- **Import providers from subpaths**, not from the main barrel:
  ```typescript
  import { OpenAIProvider } from "noumen/openai";     // correct
  import { OpenAIProvider } from "noumen";              // wrong — providers are not re-exported from main
  ```
- **Import sandbox factories and Agent from the main barrel**:
  ```typescript
  import { Agent, LocalSandbox } from "noumen";
  ```

## Counts to keep accurate

These numeric claims appear in multiple places. Grep for them when changing the relevant code:

- **Provider count** — currently 7 (OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, Vertex, Ollama)
- **Core tool count** — currently 9 (ReadFile, WriteFile, EditFile, Bash, Glob, Grep, WebFetch, NotebookEdit, AskUser)
- **Sandbox backend count** — currently 6 (LocalSandbox, UnsandboxedLocal, Sprites, Docker, E2B, Freestyle)
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
