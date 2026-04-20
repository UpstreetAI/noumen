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

### If you add/remove/rename a sandbox factory (`src/virtual/local-sandbox.ts`, `src/virtual/unsandboxed.ts`, or a remote backend in `src/virtual/*-sandbox.ts`)
- Add a subpath entry in `src/` (e.g. `src/<backend>.ts`) and register it in `tsup.config.ts` + `package.json` `exports`
- If adding a *local* backend, also consider adding a thin `{X}Agent` factory alongside `LocalAgent` / `UnsandboxedAgent` on that subpath (see `src/local.ts` / `src/unsandboxed.ts` for the pattern)
- Update `README.md` Sandboxes section (import table + per-backend example + shortcut table if applicable)
- Update `website/docs/virtual.mdx` (import table + per-backend example + shortcut section if applicable)
- Update `website/src/app/page.tsx` FEATURES array (sandbox count in "Seven sandbox backends")
- Update `website/src/components/AdapterStack.tsx` (`LOCAL_SANDBOXES` or `REMOTE_SANDBOXES`) so the picker emits the right import line

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

### If you change dot-directory handling (`src/config/dot-dirs.ts`, `DotDirConfig`, default names, or per-subsystem write paths)
- Update `README.md` Options section (`dotDirs` field) and the Project Context + Skills sections
- Update `website/docs/context.mdx` — the "Dot directories" section and the `ProjectContextConfig` table
- Update `website/docs/skills.mdx` — the "Auto-discovery" section (scan paths and precedence)

## Code example rules

- **Prefer the string provider shorthand** for simple examples:
  ```typescript
  const agent = new Agent({ provider: "anthropic", cwd: "." });
  ```
- **`sandbox` is required** on `Agent` and every preset (`codingAgent`, `planningAgent`, `reviewAgent`). The root barrel deliberately does not ship a default, so every example must either pass an explicit `sandbox` or use one of the local-backend shortcuts below.
- **Use the `sandbox` pattern** when showing explicit sandbox configuration:
  ```typescript
  import { Agent } from "noumen";
  import { LocalSandbox } from "noumen/local";

  const agent = new Agent({
    provider,
    sandbox: LocalSandbox({ cwd: "/my/project" }),
    options: { ... },
  });
  ```
- **For local sandboxes, prefer the shortcut factories** in short snippets — they package `new Agent(...)` + sandbox construction into one call and keep the import line count down:
  ```typescript
  import { LocalAgent } from "noumen/local";          // OS-level sandboxing
  import { UnsandboxedAgent } from "noumen/unsandboxed"; // raw host access

  const agent = LocalAgent({ provider: "anthropic", cwd: "." });
  ```
  These accept the full `AgentOptions` shape minus `sandbox`, plus an optional `localSandbox` / `unsandboxed` block for forwarding extra options to the underlying sandbox factory. Remote sandboxes have no shortcut — keep them on `new Agent({ provider, sandbox })` because their config (tokens, templates, connection state) is clearer at the call site.
- **Import providers from subpaths**, not from the main barrel:
  ```typescript
  import { OpenAIProvider } from "noumen/openai";     // correct
  import { OpenAIProvider } from "noumen";              // wrong — providers are not re-exported from main
  ```
- **Import every sandbox factory from its own subpath**, mirroring the provider convention. The root barrel does not export any sandbox factory — only the `Sandbox` / `VirtualFs` / `VirtualComputer` interface types — so every sandbox is opted into by import and optional peer deps never enter the module graph unless requested:
  ```typescript
  import { LocalSandbox }     from "noumen/local";        // OS-level sandboxing
  import { UnsandboxedLocal } from "noumen/unsandboxed";  // raw host access, no isolation
  import { DockerSandbox }    from "noumen/docker";       // requires `dockerode`
  import { E2BSandbox }       from "noumen/e2b";          // requires `e2b`
  import { FreestyleSandbox } from "noumen/freestyle";    // requires `freestyle-sandboxes`
  import { SshSandbox }       from "noumen/ssh";          // requires `ssh2`
  import { SpritesSandbox }   from "noumen/sprites";      // no peer dep
  ```
  A vitest invariant at `src/__tests__/barrel-cold-start.test.ts` mocks every optional peer to throw on import, asserts the root barrel still loads, and asserts no sandbox factory or adapter is reachable from it. If you add a new optional peer, add it to the list there.
- **Local adapter primitives** (`LocalFs`, `LocalComputer`, `SandboxedLocalComputer`) live on `noumen/local` next to `LocalSandbox`:
  ```typescript
  import { LocalFs } from "noumen/local";
  ```
- **Import the Agent and interface types from the main barrel**:
  ```typescript
  import { Agent, type Sandbox } from "noumen";
  ```

## Counts to keep accurate

These numeric claims appear in multiple places. Grep for them when changing the relevant code:

- **Provider count** — currently 7 (OpenAI, Anthropic, Gemini, OpenRouter, Bedrock, Vertex, Ollama)
- **Core tool count** — currently 9 (ReadFile, WriteFile, EditFile, Bash, Glob, Grep, WebFetch, NotebookEdit, AskUser)
- **Sandbox backend count** — currently 7 (LocalSandbox, UnsandboxedLocal, Sprites, Docker, E2B, Freestyle, SshSandbox)
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
