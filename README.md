# noumen 🐍

The coding agent you `npm install`.

`noumen` gives you the full agentic coding loop — tool execution, file editing, shell commands, context compaction, and session management — with sandboxed virtual infrastructure that isolates your agent from the host machine.

Any provider. Any sandbox. One package.

**[Documentation](https://noumen.dev)** · **[npm](https://www.npmjs.com/package/noumen)** · **[GitHub](https://github.com/UpstreetAI/noumen)**

## Install

```bash
pnpm add noumen
```

Then install the provider SDK you need:

```bash
pnpm add openai           # for OpenAI / OpenRouter
pnpm add @anthropic-ai/sdk  # for Anthropic
pnpm add @google/genai      # for Gemini
```

## Quick Start

```typescript
import { Code, LocalSandbox } from "noumen";
import { OpenAIProvider } from "noumen/openai";

const code = new Code({
  aiProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  sandbox: LocalSandbox({ cwd: "/my/project" }),
});

const thread = code.createThread();

for await (const event of thread.run("Add a health-check endpoint to server.ts")) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[tool] ${event.toolName}`);
      break;
    case "tool_result":
      console.log(`[result] ${event.result.content.slice(0, 200)}`);
      break;
  }
}
```

## Providers

### OpenAI

```typescript
import { OpenAIProvider } from "noumen/openai";

const provider = new OpenAIProvider({
  apiKey: "sk-...",
  model: "gpt-4o",      // default
  baseURL: "https://...", // optional, for compatible APIs
});
```

### Anthropic

```typescript
import { AnthropicProvider } from "noumen/anthropic";

const provider = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-20250514", // default
});
```

### Google Gemini

```typescript
import { GeminiProvider } from "noumen/gemini";

const provider = new GeminiProvider({
  apiKey: "...",                   // Google AI Studio API key
  model: "gemini-2.5-flash",      // default
});
```

### OpenRouter

```typescript
import { OpenRouterProvider } from "noumen/openrouter";

const provider = new OpenRouterProvider({
  apiKey: "sk-or-...",
  model: "anthropic/claude-sonnet-4",  // default
  appName: "My Agent",                 // optional, for openrouter.ai rankings
  appUrl: "https://myapp.com",         // optional
});
```

### AWS Bedrock (Anthropic)

Route Anthropic models through AWS Bedrock. Requires `@anthropic-ai/bedrock-sdk`:

```bash
pnpm add @anthropic-ai/bedrock-sdk
```

```typescript
import { BedrockAnthropicProvider } from "noumen/bedrock";

const provider = new BedrockAnthropicProvider({
  region: "us-west-2",                                     // default: us-east-1
  model: "us.anthropic.claude-sonnet-4-20250514-v1:0",     // default
  credentials: {                                            // optional, falls back to default chain
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
  cacheControl: { enabled: true },                          // optional prompt caching
});
```

When `credentials` is omitted, the SDK uses the standard AWS credential chain (env vars, `~/.aws/credentials`, IAM roles, etc.).

### Google Vertex AI (Anthropic)

Route Anthropic models through Google Cloud Vertex AI. Requires `@anthropic-ai/vertex-sdk` and `google-auth-library`:

```bash
pnpm add @anthropic-ai/vertex-sdk google-auth-library
```

```typescript
import { VertexAnthropicProvider } from "noumen/vertex";

const provider = new VertexAnthropicProvider({
  projectId: "my-gcp-project",
  region: "us-east5",                     // default
  model: "claude-sonnet-4@20250514",      // default
  cacheControl: { enabled: true },        // optional prompt caching
});
```

When `googleAuth` is omitted, the provider creates a `GoogleAuth` instance using application default credentials. You can pass your own `googleAuth` instance for custom authentication:

```typescript
import { GoogleAuth } from "google-auth-library";

const provider = new VertexAnthropicProvider({
  projectId: "my-project",
  googleAuth: new GoogleAuth({ keyFile: "/path/to/service-account.json" }),
});
```

## Sandboxes

A `Sandbox` bundles a `VirtualFs` (filesystem) and `VirtualComputer` (shell execution) into one object. Every file read/write and shell command the agent executes goes through these interfaces — swap the sandbox to control what the agent can access.

### Local (Node.js) — no isolation

Backed by `fs/promises` and `child_process`. Use for local development and trusted environments:

```typescript
import { LocalSandbox } from "noumen";

const sandbox = LocalSandbox({ cwd: "/my/project" });
```

### sprites.dev — full sandbox

Run inside a remote [sprites.dev](https://docs.sprites.dev) container. The agent has no access to the host machine:

```typescript
import { SpritesSandbox } from "noumen";

const sandbox = SpritesSandbox({
  token: process.env.SPRITE_TOKEN,
  spriteName: "my-sprite",
});
```

### Docker — container isolation

Run the agent inside a Docker container. Requires `dockerode` as an optional peer dependency:

```bash
pnpm add dockerode
```

```typescript
import Docker from "dockerode";
import { DockerSandbox } from "noumen";

const docker = new Docker();
const container = await docker.createContainer({
  Image: "node:22",
  Cmd: ["sleep", "infinity"],
  Tty: false,
});
await container.start();

const sandbox = DockerSandbox({
  container,
  cwd: "/workspace",
});

// Use the sandbox normally — all commands/files run inside the container
const code = new Code({ aiProvider, sandbox });

// Clean up when done
await container.stop();
await container.remove();
```

You are responsible for container lifecycle (create, start, stop, remove). The sandbox just wraps the running container.

### E2B — cloud sandbox

Run the agent inside an [E2B](https://e2b.dev) cloud sandbox. Requires `e2b` as an optional peer dependency:

```bash
pnpm add e2b
```

```typescript
import { Sandbox as E2BSandboxSDK } from "e2b";
import { E2BSandbox } from "noumen";

const e2b = await E2BSandboxSDK.create();

const sandbox = E2BSandbox({
  sandbox: e2b,
  cwd: "/home/user",
});

const code = new Code({ aiProvider, sandbox });

// Clean up when done
await e2b.close();
```

You are responsible for sandbox lifecycle (create, close). The adapter maps `VirtualFs` and `VirtualComputer` to E2B's `files` and `commands` APIs.

### Custom sandboxes

Implement `VirtualFs` and `VirtualComputer` to target any execution environment — Daytona, cloud VMs, or an in-memory test harness. A custom `Sandbox` is any object with `{ fs, computer }`:

```typescript
import type { Sandbox } from "noumen";

const sandbox: Sandbox = {
  fs: new MyCustomFs(),
  computer: new MyCustomComputer(),
};
```

The interfaces are intentionally minimal (one method for shell, eight for filesystem) so adapters are straightforward to write.

## Options

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    sessionDir: ".noumen/sessions", // JSONL transcript storage path
    model: "gpt-4o",                   // default model
    maxTokens: 8192,                   // max output tokens per turn
    autoCompact: true,                 // auto-compact when context is large
    autoCompactThreshold: 100_000,     // token threshold for auto-compact
    systemPrompt: "...",               // override the built-in system prompt
    cwd: "/working/dir",              // working directory for tools
    skills: [{ name: "...", content: "..." }],
    skillsPaths: [".claude/skills"],   // paths to SKILL.md files on virtualFs
    projectContext: true,              // load NOUMEN.md / CLAUDE.md from project

    // Extended thinking / reasoning (see below)
    thinking: { type: "enabled", budgetTokens: 10000 },

    // Retry / error resilience (see below)
    retry: true,                       // use defaults, or pass a RetryConfig

    // Cost tracking (see below)
    costTracking: { enabled: true },
  },
});
```

## Threads

```typescript
// New thread
const thread = code.createThread();

// Resume an existing session
const thread = code.createThread({ sessionId: "abc-123", resume: true });

// Run a prompt (returns an async iterable of stream events)
for await (const event of thread.run("Fix the failing test")) {
  // handle events
}

// Get conversation history
const messages = await thread.getMessages();

// Manually compact the conversation
await thread.compact();

// Abort a running request
thread.abort();
```

## Stream Events

| Event | Fields | Description |
|-------|--------|-------------|
| `text_delta` | `text` | Incremental text from the model |
| `thinking_delta` | `text` | Incremental thinking/reasoning text from the model |
| `tool_use_start` | `toolName`, `toolUseId` | Model is calling a tool |
| `tool_use_delta` | `input` | Incremental tool call arguments |
| `tool_result` | `toolUseId`, `toolName`, `result` | Tool execution result |
| `message_complete` | `message` | Full assistant message |
| `usage` | `usage`, `model` | Token usage for a single model call |
| `cost_update` | `summary` | Updated cost summary after each model call |
| `turn_complete` | `usage`, `model`, `callCount` | Accumulated usage for the full agent turn |
| `retry_attempt` | `attempt`, `maxRetries`, `delayMs`, `error` | A retryable error occurred; waiting before retry |
| `retry_exhausted` | `attempts`, `error` | All retries exhausted |
| `compact_start` | | Auto-compaction started |
| `compact_complete` | | Auto-compaction finished |
| `error` | `error` | An error occurred |

## Built-in Tools

### Core tools (always available)

| Tool | Description |
|------|-------------|
| **ReadFile** | Read files with line numbers, offset/limit support |
| **WriteFile** | Create or overwrite files |
| **EditFile** | Find-and-replace string editing |
| **Bash** | Execute shell commands |
| **Glob** | Find files by glob pattern (via ripgrep) |
| **Grep** | Search file contents by regex (via ripgrep) |
| **WebFetch** | Fetch a URL and return contents as markdown |
| **NotebookEdit** | Edit Jupyter notebook cells (replace, insert, delete) |
| **AskUser** | Ask the user a question and wait for a response |

### Optional tools (enabled via Code options)

| Tool | Requires | Description |
|------|----------|-------------|
| **Agent** | `enableSubagents` | Spawn an isolated subagent for focused subtasks |
| **Skill** | `skills` / `skillsPaths` | Invoke a named skill with arguments |
| **TaskCreate** | `enableTasks` | Create a work item for tracking |
| **TaskList** | `enableTasks` | List all tasks with status |
| **TaskGet** | `enableTasks` | Get task details by ID |
| **TaskUpdate** | `enableTasks` | Update task status/description |
| **EnterPlanMode** | `enablePlanMode` | Switch to read-only exploration mode |
| **ExitPlanMode** | `enablePlanMode` | Return to normal mode with optional plan |
| **EnterWorktree** | `enableWorktrees` | Create an isolated git worktree |
| **ExitWorktree** | `enableWorktrees` | Leave and optionally clean up worktree |
| **LSP** | `enableLsp` | Query language servers (definitions, references, hover) |
| **WebSearch** | `webSearch` config | Search the web via a user-provided backend |
| **ToolSearch** | `toolSearch` | Discover deferred tools on demand (reduces context usage) |

## Extended Thinking

Enable model reasoning/thinking for supported providers. Each provider maps the config to its native format:

- **Anthropic**: Sets `thinking.budget_tokens` on the API call
- **OpenAI**: Maps to `reasoning_effort: "high"` for o-series models
- **Gemini**: Sets `thinkingConfig.thinkingBudget`

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    thinking: { type: "enabled", budgetTokens: 10000 },
  },
});

for await (const event of thread.run("Solve this complex problem")) {
  if (event.type === "thinking_delta") {
    process.stderr.write(event.text); // reasoning trace
  }
  if (event.type === "text_delta") {
    process.stdout.write(event.text); // final answer
  }
}
```

Disable explicitly with `{ type: "disabled" }`, or omit the option entirely for default behavior.

## Retry / Error Resilience

Automatic retries with exponential backoff, Retry-After header support, context overflow recovery, and model fallback. Handles 429 (rate limit), 529 (overloaded), 500/502/503 (server errors), and connection failures.

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    retry: true, // use sensible defaults
  },
});

// Or customize:
const code2 = new Code({
  aiProvider,
  sandbox,
  options: {
    retry: {
      maxRetries: 10,
      baseDelayMs: 500,
      maxDelayMs: 32000,
      retryableStatuses: [408, 429, 500, 502, 503, 529],
      fallbackModel: "gpt-4o-mini",     // switch model after repeated 529s
      maxConsecutiveOverloaded: 3,
      onRetry: (attempt, error, delayMs) => {
        console.log(`Retry ${attempt}, waiting ${delayMs}ms: ${error.message}`);
      },
    },
  },
});
```

On context overflow (input + max_tokens > context limit), the engine automatically reduces `max_tokens` and retries — no manual intervention needed.

## Cost Tracking

Track token usage and estimate USD costs across all model calls. Includes built-in pricing for Claude, GPT-4o, Gemini, and o-series models.

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    costTracking: { enabled: true },
  },
});

const thread = code.createThread();

for await (const event of thread.run("Refactor the auth module")) {
  if (event.type === "cost_update") {
    console.log(`Running cost: $${event.summary.totalCostUSD.toFixed(4)}`);
  }
}

// Or get the summary at any time
const summary = code.getCostSummary();
console.log(`Total: $${summary.totalCostUSD.toFixed(4)}`);
console.log(`Input tokens: ${summary.totalInputTokens}`);
console.log(`Output tokens: ${summary.totalOutputTokens}`);
```

Supply custom pricing for unlisted models:

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    costTracking: {
      enabled: true,
      pricing: {
        "my-custom-model": {
          inputTokens: 1,    // USD per 1M tokens
          outputTokens: 3,
        },
      },
    },
  },
});
```

## Skills

Skills are markdown instructions injected into the system prompt. Provide them inline or load from `SKILL.md` files on the virtual filesystem:

```typescript
const code = new Code({
  aiProvider,
  sandbox,
  options: {
    skills: [
      { name: "Testing", content: "Always write vitest tests for new code." },
    ],
    skillsPaths: [".claude/skills", "~/.config/skills"],
  },
});

// If using skillsPaths, call init() to pre-load them
await code.init();
```

## Project Context (NOUMEN.md / CLAUDE.md)

Drop a `NOUMEN.md` or `CLAUDE.md` in your project root to give the agent persistent instructions:

```markdown
# Project instructions

This is a TypeScript monorepo. Use strict mode. Write vitest tests for all new code.
```

Enable it with `projectContext: true` in your `Code` options. The loader discovers context files from four layers — managed (enterprise), user (`~/.noumen/`), project (repo ancestors), and local (`.local.md`, gitignored) — so you can scope instructions at any level.

This is fully compatible with `CLAUDE.md`. If your project already has one, noumen picks it up automatically. Both `NOUMEN.md` and `CLAUDE.md` can coexist in the same directory. The format supports `@path` includes, conditional rules via `paths:` frontmatter in `.noumen/rules/` directories, and hierarchical overriding.

See **[noumen.dev/docs/context](https://noumen.dev/docs/context)** for full configuration options.

## Sessions

Conversations are persisted as JSONL files on the virtual filesystem. Each line is a serialized message entry. Compaction writes a boundary marker followed by a summary, so resumed sessions only load post-boundary messages.

```typescript
// List all saved sessions
const sessions = await code.listSessions();
// [{ sessionId, createdAt, lastMessageAt, title?, messageCount }]
```

## Hooks

Intercept tool calls, turn lifecycle, subagent spawning, compaction, and errors:

```typescript
const code = new Code({
  aiProvider, sandbox,
  options: {
    hooks: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        handler: async (input) => {
          console.log(`Bash: ${input.toolInput.command}`);
          return { decision: "allow" };
        },
      },
      {
        event: "TurnEnd",
        handler: async (input) => {
          console.log(`Turn ended for ${input.sessionId}`);
        },
      },
    ],
  },
});
```

Events: `PreToolUse`, `PostToolUse`, `TurnStart`, `TurnEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Error`.

## Permissions

Control what tools the agent can use with modes and rules:

```typescript
options: {
  permissions: {
    mode: "default", // or "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"
    rules: [
      { toolName: "Bash", behavior: "ask", source: "project" },
      { toolName: "ReadFile", behavior: "allow", source: "user" },
    ],
    handler: async (request) => ({ allow: true }),
  },
}
```

## Multi-Agent Swarm

Run multiple agents in parallel with message passing:

```typescript
import { SwarmManager, InProcessBackend } from "noumen";

const backend = new InProcessBackend(code);
const swarm = new SwarmManager(backend, { maxConcurrent: 3 });

await swarm.spawn({ name: "researcher", prompt: "Find all TODOs" });
await swarm.spawn({ name: "writer", prompt: "Write tests for auth" });
await swarm.waitForAll();
```

## Memory

Persist knowledge across sessions:

```typescript
import { FileMemoryProvider, LocalFs } from "noumen";

options: {
  memory: {
    provider: new FileMemoryProvider(new LocalFs({ basePath: ".noumen/memory" })),
    autoExtract: true,
    injectIntoSystemPrompt: true,
  },
}
```

## MCP (Model Context Protocol)

Connect to MCP servers to discover and use external tools:

```typescript
options: {
  mcpServers: [
    { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    { type: "http", url: "http://localhost:3001/mcp" },
  ],
}
```

Or expose noumen's tools as an MCP server (requires `@modelcontextprotocol/sdk`):

```bash
pnpm add @modelcontextprotocol/sdk
```

```typescript
import { createMcpServer } from "noumen/mcp";
const server = createMcpServer({ tools: registry.listTools() });
```

## Tracing

Instrument agent runs with OpenTelemetry:

```typescript
import { OTelTracer } from "noumen";

options: {
  tracing: { tracer: await OTelTracer.create("my-agent") },
}
```

Falls back to no-op if `@opentelemetry/api` is not installed.

## Full Documentation

See **[noumen.dev](https://noumen.dev)** for complete documentation on all features including hooks, permissions, compaction strategies, LSP integration, task management, worktrees, plan mode, and more.

## License

MIT
