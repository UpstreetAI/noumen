# noumen 🐍

The agent runtime you `npm install`.

`noumen` gives you the full agentic loop — tool execution, file editing, shell commands, context compaction, and session management — with sandboxed virtual infrastructure that isolates your agent from the host machine. Built for coding agents. Ready for any agent that uses a computer.

Any provider. Any sandbox. One package.

**[Documentation](https://noumen.dev)** · **[npm](https://www.npmjs.com/package/noumen)** · **[GitHub](https://github.com/UpstreetAI/noumen)**

## Install

```bash
pnpm add noumen
```

Then install the provider SDK you need:

```bash
pnpm add openai           # for OpenAI / OpenRouter / Ollama
pnpm add @anthropic-ai/sdk  # for Anthropic
pnpm add @google/genai      # for Gemini
# Ollama requires no SDK — just install https://ollama.com
```

## Quick Start

```typescript
import { Agent } from "noumen";

const agent = new Agent({ provider: "anthropic", cwd: "." });

for await (const event of agent.run("Add a health-check endpoint to server.ts")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

Three lines to a working agent. The string provider auto-detects your `ANTHROPIC_API_KEY` from the environment, and `cwd` defaults to a local sandbox.

### Execute (run to completion)

```typescript
const result = await agent.execute("Fix the auth bug", {
  onText: (text) => process.stdout.write(text),
  onToolUse: (name) => console.log(`Using ${name}`),
});
console.log(`Done — ${result.toolCalls} tool calls`);
```

`agent.run()` streams events via an async generator. `agent.execute()` runs to completion and returns a `RunResult` — callbacks are optional event listeners along the way.

### Full control

```typescript
import { Agent } from "noumen";
import { LocalSandbox } from "noumen/local";
import { OpenAIProvider } from "noumen/openai";

const agent = new Agent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  sandbox: LocalSandbox({ cwd: "/my/project" }),
});

const thread = agent.createThread();

for await (const event of thread.run("Refactor the auth module")) {
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

## Presets

For zero-config setup, use a preset that configures everything for you:

```typescript
import { codingAgent } from "noumen";
import { OpenAIProvider } from "noumen/openai";

const agent = codingAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  cwd: "/my/project",
});

await agent.init();
const thread = agent.createThread();

for await (const event of thread.run("Refactor the auth module")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}

await agent.close();
```

Three presets are available:

| Preset | Mode | Includes |
|--------|------|----------|
| `codingAgent` | `default` | Subagents, tasks, plan mode, auto-compact, retry, cost tracking, project context |
| `planningAgent` | `plan` | Read-only exploration, plan mode enabled |
| `reviewAgent` | `plan` | Read-only + web search for documentation lookups |

## CLI

noumen ships a CLI for using the agent directly from the terminal, with any provider.

```bash
# Interactive mode — auto-detects provider from env vars
npx noumen

# One-shot with a specific provider
npx noumen -p anthropic "Add error handling to server.ts"

# Pipe input
cat plan.md | npx noumen -p openai

# JSONL output for scripting
npx noumen --json -c "List all TODO comments" > events.jsonl
```

### Setup

```bash
noumen init
```

This creates `.noumen/config.json` with your provider and model choice. The CLI also reads `NOUMEN.md` files for project instructions (see [Project Context](#project-context)).

### Config file

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "permissions": "acceptEdits"
}
```

Place in `.noumen/config.json` at your project root. The CLI walks up from the working directory to find it.

### Flags

| Flag | Description |
|------|-------------|
| `-p, --provider` | `openai`, `anthropic`, `gemini`, `openrouter`, `bedrock`, `vertex`, `ollama` |
| `-m, --model` | Model name (provider-specific default if omitted) |
| `--api-key` | Override API key |
| `--base-url` | Override provider base URL |
| `-c, --prompt` | One-shot prompt (non-interactive) |
| `--permission` | Permission mode: `default`, `plan`, `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk` |
| `--thinking` | Thinking level: `off`, `low`, `medium`, `high` |
| `--max-turns` | Max agent turns before stopping |
| `--json` | Emit JSONL stream events to stdout |
| `--quiet` | Only output final text |
| `--verbose` | Show tool calls and thinking |
| `--cwd` | Working directory |

### API key resolution

1. `--api-key` flag
2. Provider-specific env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`)
3. `NOUMEN_API_KEY` generic env var
4. `.noumen/config.json` `apiKey` field

Ollama, Bedrock, and Vertex do not require an API key.

### Commands

| Command | Description |
|---------|-------------|
| `noumen init` | Create `.noumen/config.json` |
| `noumen sessions` | List past sessions |
| `noumen resume <id>` | Resume a previous session (prefix match) |

## Embedding

noumen is a library first. Six integration patterns:

**In-process** — `Agent` + `Thread.run()` async iterator, direct import:

```typescript
const thread = agent.createThread();
for await (const event of thread.run("Fix the bug")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

**HTTP/SSE server** — expose the agent over HTTP:

```typescript
import { createServer } from "noumen/server";
const server = createServer(agent, { port: 3001, auth: { type: "bearer", token: "..." } });
await server.start();
```

**Middleware** — mount on Express, Fastify, or Hono:

```typescript
import { createRequestHandler } from "noumen/server";
app.use("/agent", createRequestHandler(agent, { auth: { type: "bearer", token: "..." } }));
```

**WebSocket** — bidirectional with permission handling:

```typescript
import { NoumenClient } from "noumen/client";
const client = new NoumenClient({ baseUrl: "http://localhost:3001", transport: "ws" });
for await (const event of client.run("Deploy to staging")) { /* ... */ }
```

**Headless CLI** — NDJSON subprocess control from any language:

```bash
npx noumen --headless -p anthropic <<< '{"type":"prompt","text":"Fix the bug"}'
```

**Frameworks** — Next.js API routes, Electron IPC, VS Code extensions. See the [full embedding guide](https://noumen.dev/docs/embedding) and [Server API Reference](https://noumen.dev/docs/server-api).

**Health checks** — verify all integrations work before running:

```typescript
const result = await agent.diagnose();
// {
//   overall: true,
//   provider: { ok: true, latencyMs: 342, model: "claude-sonnet-4" },
//   sandbox: {
//     fs: { ok: true, latencyMs: 2 },
//     computer: { ok: true, latencyMs: 45 },
//   },
//   mcp: { filesystem: { ok: true, latencyMs: 0, status: "connected", toolCount: 5 } },
//   lsp: {},
//   timestamp: "2026-04-04T12:00:00.000Z",
// }
```

Or from the CLI:

```bash
npx noumen doctor
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
  model: "claude-sonnet-4", // default
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
  model: "us.anthropic.claude-sonnet-4-v1:0",               // default
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
  model: "claude-sonnet-4",               // default
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

### Ollama (Local)

Run models locally with [Ollama](https://ollama.com). No API key needed — just install Ollama and pull a model:

```bash
ollama pull qwen2.5-coder:32b
ollama serve
```

```typescript
import { OllamaProvider } from "noumen/ollama";

const provider = new OllamaProvider({
  model: "qwen2.5-coder:32b",   // default
  baseURL: "http://localhost:11434/v1",  // default
});
```

The CLI auto-detects a running Ollama server when no cloud API keys are set, so you can simply run `noumen` with Ollama serving in the background.

## Sandboxes

A `Sandbox` bundles a `VirtualFs` (filesystem) and `VirtualComputer` (shell execution) into one object. Every file read/write and shell command the agent executes goes through these interfaces — swap the sandbox to control what the agent can access.

Local factories live on the root barrel; each remote backend ships on its own subpath so its optional peer dep only enters the module graph when you opt in:

Every sandbox factory lives on its own subpath, so importing `noumen` never drags a backend's peer deps into the module graph.

| Factory | Import | Peer dep |
| --- | --- | --- |
| `LocalSandbox` | `noumen/local` | `@anthropic-ai/sandbox-runtime` (bundled) |
| `UnsandboxedLocal` | `noumen/unsandboxed` | — |
| `SpritesSandbox` | `noumen/sprites` | — |
| `DockerSandbox` | `noumen/docker` | `dockerode` |
| `E2BSandbox` | `noumen/e2b` | `e2b` |
| `FreestyleSandbox` | `noumen/freestyle` | `freestyle-sandboxes` |
| `SshSandbox` | `noumen/ssh` | `ssh2` |

### Local — OS-level sandboxing

Backed by `@anthropic-ai/sandbox-runtime`. Uses macOS Seatbelt or Linux bubblewrap to restrict filesystem and network access at the OS level — no containers needed:

```bash
pnpm add @anthropic-ai/sandbox-runtime
```

```typescript
import { LocalSandbox } from "noumen/local";

const sandbox = LocalSandbox({ cwd: "/my/project" });

// Customize restrictions:
const restricted = LocalSandbox({
  cwd: "/my/project",
  sandbox: {
    filesystem: { denyRead: ["/etc/shadow"] },
    network: { allowedDomains: ["api.openai.com"] },
  },
});
```

Defaults: writes allowed only in `cwd`, reads allowed everywhere, network unrestricted.

### UnsandboxedLocal — no isolation

Backed by `fs/promises` and `child_process` with no OS-level restrictions. Use for development or trusted environments:

```typescript
import { UnsandboxedLocal } from "noumen/unsandboxed";

const sandbox = UnsandboxedLocal({ cwd: "/my/project" });
```

### sprites.dev — full sandbox

Run inside a remote [sprites.dev](https://docs.sprites.dev) container. The agent has no access to the host machine.

**Auto-create** — omit `spriteName` and the sprite is provisioned on first use. The sandbox ID is persisted so sessions can reconnect on resume. `Agent.close()` tears the sprite down automatically:

```typescript
import { SpritesSandbox } from "noumen/sprites";

const sandbox = SpritesSandbox({ token: process.env.SPRITE_TOKEN });
```

**Explicit** — pass `spriteName` to attach to a pre-existing sprite. The caller owns the sprite's lifecycle:

```typescript
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

**Auto-create** — pass `image` instead of `container` and the container is created and started on first use. `Agent.close()` stops and removes it:

```typescript
import { DockerSandbox } from "noumen/docker";

const sandbox = DockerSandbox({ image: "node:22", cwd: "/workspace" });
const agent = new Agent({ provider, sandbox });

// Container auto-created on first thread. Cleaned up by:
await agent.close();
```

**Explicit** — pass a pre-existing dockerode `Container`. The caller owns its lifecycle:

```typescript
import Docker from "dockerode";
import { DockerSandbox } from "noumen/docker";

const docker = new Docker();
const container = await docker.createContainer({
  Image: "node:22",
  Cmd: ["sleep", "infinity"],
  Tty: false,
});
await container.start();

const sandbox = DockerSandbox({ container, cwd: "/workspace" });
const agent = new Agent({ provider, sandbox });

await container.stop();
await container.remove();
```

### E2B — cloud sandbox

Run the agent inside an [E2B](https://e2b.dev) cloud sandbox. Requires `e2b` as an optional peer dependency:

```bash
pnpm add e2b
```

**Auto-create** — omit `sandbox` and the E2B sandbox is provisioned on first use via the `e2b` SDK. `Agent.close()` kills it:

```typescript
import { E2BSandbox } from "noumen/e2b";

const sandbox = E2BSandbox({ template: "base" });
const agent = new Agent({ provider, sandbox });

await agent.close(); // kills the E2B sandbox
```

**Explicit** — pass a pre-existing `Sandbox` instance. The caller owns its lifecycle:

```typescript
import { Sandbox as E2BSandboxSDK } from "e2b";
import { E2BSandbox } from "noumen/e2b";

const e2b = await E2BSandboxSDK.create();

const sandbox = E2BSandbox({
  sandbox: e2b,
  cwd: "/home/user",
});

const agent = new Agent({ provider, sandbox });

await e2b.close();
```

### Freestyle — cloud VMs

Run the agent inside a [Freestyle](https://freestyle.sh) VM. Full Linux VMs with sub-second startup, instant pause/resume, and optional forking. Requires `freestyle-sandboxes` as an optional peer dependency:

```bash
pnpm add freestyle-sandboxes
```

**Auto-create** — omit `vm` and a Freestyle VM is provisioned on first use. `Agent.close()` **suspends** (not deletes) the VM so it can resume instantly later:

```typescript
import { FreestyleSandbox } from "noumen/freestyle";

const sandbox = FreestyleSandbox({ cwd: "/workspace" });
const agent = new Agent({ provider, sandbox });

await agent.close(); // suspends the VM (preserves full memory state)
```

**From a snapshot** — start from a cached environment:

```typescript
const sandbox = FreestyleSandbox({
  snapshotId: "abc123",
  cwd: "/workspace",
});
```

**Explicit** — pass a pre-existing VM instance. The caller owns its lifecycle:

```typescript
import { freestyle } from "freestyle-sandboxes";
import { FreestyleSandbox } from "noumen/freestyle";

const { vm } = await freestyle.vms.create({ workdir: "/workspace" });

const sandbox = FreestyleSandbox({ vm, cwd: "/workspace" });
const agent = new Agent({ provider, sandbox });
```

### SSH — remote hosts

Connect to any remote machine over SSH. Uses `ssh2` for command execution (exec channels) and file I/O (SFTP):

```bash
pnpm add ssh2
```

**Auto-connect** — provide credentials and the connection is established lazily on `init()`:

```typescript
import { Agent } from "noumen";
import { SshSandbox } from "noumen/ssh";
import fs from "node:fs";

const agent = new Agent({
  provider,
  sandbox: SshSandbox({
    host: "dev.example.com",
    username: "deploy",
    privateKey: fs.readFileSync("/home/deploy/.ssh/id_ed25519"),
    cwd: "/home/deploy/project",
  }),
});
```

Password auth is also supported — pass `password` instead of `privateKey`.

**Explicit** — pass a pre-connected ssh2 Client. The caller owns its lifecycle:

```typescript
import { Client } from "ssh2";
import { SshSandbox } from "noumen/ssh";

const client = new Client();
await new Promise<void>((resolve) => {
  client.on("ready", resolve);
  client.connect({ host: "10.0.0.5", username: "root", privateKey: key });
});

const sandbox = SshSandbox({ client, cwd: "/workspace" });
const agent = new Agent({ provider, sandbox });
```

### Sandbox auto-creation lifecycle

All five remote backends (Sprites, Docker, E2B, Freestyle, SSH) support on-demand provisioning. When you omit the container/instance and let the factory auto-create:

1. **First `createThread()`** calls `sandbox.init()` which provisions the resource
2. The sandbox ID is persisted locally (`.noumen/sessions/.sandbox-index.json`) so `resumeThread()` can reconnect to the same resource
3. **`Agent.close()`** calls `sandbox.dispose()` which tears down auto-created resources
4. Resources created by the user (explicit IDs) are never torn down by `dispose()`

`init()` is idempotent — multiple `createThread()` calls reuse the same provisioned resource.

### Custom sandboxes

Implement `VirtualFs` and `VirtualComputer` to target any execution environment — Daytona, cloud VMs, or an in-memory test harness. A custom `Sandbox` is any object with `{ fs, computer }`:

```typescript
import type { Sandbox } from "noumen";

const sandbox: Sandbox = {
  fs: new MyCustomFs(),
  computer: new MyCustomComputer(),
  // Optional lazy provisioning:
  init: async (reconnectId) => { /* create or reconnect */ },
  sandboxId: () => "my-resource-id",
  dispose: async () => { /* tear down */ },
};
```

The interfaces are intentionally minimal (one method for shell, eight for filesystem) so adapters are straightforward to write. The optional `init()`, `sandboxId()`, and `dispose()` methods enable auto-creation and session-aware lifecycle management.

## Options

```typescript
const agent = new Agent({
  provider: "anthropic",
  cwd: "/my/project",
  options: {
    sessionDir: ".noumen/sessions", // JSONL transcript storage path
    model: "claude-sonnet-4",       // default model
    maxTokens: 8192,                // max output tokens per turn
    autoCompact: true,              // auto-compact when context is large
    autoCompactThreshold: 100_000,  // token threshold for auto-compact
    systemPrompt: "...",            // override the built-in system prompt
    skills: [{ name: "...", content: "..." }],
    skillsPaths: [".claude/skills"],   // extra paths to SKILL.md files (adds to auto-discovered .noumen/skills + .claude/skills)
    projectContext: true,              // load NOUMEN.md / CLAUDE.md from project

    // Dot-directory layout (controls where .noumen / .claude state lives).
    // Default: [".noumen", ".claude"]. First name wins for writes; all names
    // are scanned for reads, and every name is protected by the dangerous-path
    // permission check.
    dotDirs: { names: [".noumen", ".claude"] },

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
const thread = agent.createThread();

// Resume an existing session
const thread = agent.createThread({ sessionId: "abc-123", resume: true });

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
| `microcompact_complete` | `tokensFreed` | Microcompaction freed tokens from tool results |
| `tool_result_truncated` | `toolCallId`, `originalChars`, `truncatedChars` | A tool result was truncated by the budget system |
| `permission_request` | `toolName`, `input`, `message` | Tool call requires user approval |
| `permission_granted` | `toolName`, `input` | Permission was granted for a tool call |
| `permission_denied` | `toolName`, `input`, `message` | Permission was denied for a tool call |
| `denial_limit_exceeded` | `consecutiveDenials`, `totalDenials` | Denial tracking limits hit |
| `user_input_request` | `toolUseId`, `question` | The agent is asking the user a question |
| `subagent_start` | `toolUseId`, `prompt` | A subagent is being spawned |
| `subagent_end` | `toolUseId`, `result` | A subagent finished |
| `session_resumed` | `sessionId`, `messageCount` | A previous session was restored |
| `checkpoint_snapshot` | `messageId` | A file checkpoint was taken before edits |
| `recovery_filtered` | `filterName`, `removedCount` | Corrupt entries were filtered during session restore |
| `interrupted_turn_detected` | `kind` | A previous turn was interrupted (`interrupted_tool` or `interrupted_prompt`) |
| `memory_update` | `created`, `updated`, `deleted` | Memories were extracted from the conversation |
| `span_start` | `name`, `spanId` | An OpenTelemetry-compatible span started |
| `span_end` | `name`, `spanId`, `durationMs`, `error?` | A span ended |
| `git_operation` | `operation`, `details` | A git operation was detected |
| `structured_output` | `data`, `schema` | Structured output was produced |
| `max_turns_reached` | `maxTurns`, `turnCount` | The agent hit the maxTurns limit |
| `error` | `error` | An error occurred |

See **[noumen.dev/docs/stream-events](https://noumen.dev/docs/stream-events)** for the full event reference.

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

### Optional tools (enabled via Agent options)

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
| **LSP** | `lsp` config | Query language servers (definitions, references, hover) |
| **WebSearch** | `webSearch` config | Search the web via a user-provided backend |
| **ToolSearch** | `toolSearch` | Discover deferred tools on demand (reduces context usage) |

## Extended Thinking

Enable model reasoning/thinking for supported providers. Each provider maps the config to its native format:

- **Anthropic**: Sets `thinking.budget_tokens` on the API call
- **OpenAI**: Maps to `reasoning_effort: "high"` for o-series models
- **Gemini**: Sets `thinkingConfig.thinkingBudget`

```typescript
const agent = new Agent({
  provider: "anthropic",
  cwd: ".",
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
const agent = new Agent({
  provider: "anthropic",
  cwd: ".",
  options: {
    retry: true, // use sensible defaults
  },
});

// Or customize:
const agent2 = new Agent({
  provider: "anthropic",
  cwd: ".",
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
const agent = new Agent({
  provider: "anthropic",
  cwd: ".",
  options: {
    costTracking: { enabled: true },
  },
});

const thread = agent.createThread();

for await (const event of thread.run("Refactor the auth module")) {
  if (event.type === "cost_update") {
    console.log(`Running cost: $${event.summary.totalCostUSD.toFixed(4)}`);
  }
}

// Or get the summary at any time
const summary = agent.getCostSummary();
console.log(`Total: $${summary.totalCostUSD.toFixed(4)}`);
console.log(`Input tokens: ${summary.totalInputTokens}`);
console.log(`Output tokens: ${summary.totalOutputTokens}`);
```

Supply custom pricing for unlisted models:

```typescript
const agent = new Agent({
  provider: "anthropic",
  cwd: ".",
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

Skills are markdown instructions injected into the system prompt. They are auto-discovered from `<cwd>/.noumen/skills/` and `<cwd>/.claude/skills/` (and the same paths under `$HOME`), and can also be provided inline or loaded from explicit paths:

```typescript
const agent = new Agent({
  provider: "anthropic",
  cwd: ".",
  options: {
    skills: [
      { name: "Testing", content: "Always write vitest tests for new code." },
    ],
    skillsPaths: ["~/.config/skills"], // additive to auto-discovery
  },
});

// If using skillsPaths, call init() to pre-load them
await agent.init();
```

Auto-discovery follows the configured `dotDirs` list (default `[".noumen", ".claude"]`). On name collisions, project skills win over home skills, and the **first** dot-dir in the list wins within a scope — so `.noumen/skills/foo` overrides `.claude/skills/foo`. Only `<dot-dir>/skills/<name>/SKILL.md` is discovered; loose `SKILL.md` files at the dot-dir root are ignored.

## Project Context (NOUMEN.md / CLAUDE.md)

Drop a `NOUMEN.md` or `CLAUDE.md` in your project root to give the agent persistent instructions:

```markdown
# Project instructions

This is a TypeScript monorepo. Use strict mode. Write vitest tests for all new code.
```

Enable it with `projectContext: true` in your `Agent` options. The loader discovers context files from four layers — managed (enterprise), user (`~/.noumen/`), project (repo ancestors), and local (`.local.md`, gitignored) — so you can scope instructions at any level.

This is fully compatible with `CLAUDE.md`. If your project already has one, noumen picks it up automatically. Both `NOUMEN.md` and `CLAUDE.md` can coexist in the same directory. The format supports `@path` includes, conditional rules via `paths:` frontmatter in `.noumen/rules/` directories, and hierarchical overriding.

The set of dot-directory names is configurable via `dotDirs` (default `[".noumen", ".claude"]`). The same list drives `NOUMEN.md`/`CLAUDE.md` discovery, auto-discovered skills (under `<dot-dir>/skills/`), CLI config lookup (`<dot-dir>/config.json`), and agent-managed state (sessions, checkpoints, worktrees, OAuth tokens). Writes always go to the **first** name in the list; reads fall back through the rest in order.

See **[noumen.dev/docs/context](https://noumen.dev/docs/context)** for full configuration options.

## Sessions

Conversations are persisted as JSONL files on the virtual filesystem. Each line is a serialized message entry. Compaction writes a boundary marker followed by a summary, so resumed sessions only load post-boundary messages.

```typescript
// List all saved sessions
const sessions = await agent.listSessions();
// [{ sessionId, createdAt, lastMessageAt, title?, messageCount }]
```

## Hooks

18 hook events across six categories — intercept tool calls, session lifecycle, permissions, file writes, model switches, compaction, retry, memory, and errors:

```typescript
const agent = new Agent({
  provider: "anthropic", cwd: ".",
  options: {
    hooks: [
      {
        event: "SessionStart",
        handler: async (input) => {
          console.log(`Session ${input.sessionId} started (resume: ${input.isResume})`);
        },
      },
      {
        event: "PreToolUse",
        matcher: "Bash",
        handler: async (input) => {
          console.log(`Bash: ${input.toolInput.command}`);
          return { decision: "allow" };
        },
      },
      {
        event: "FileWrite",
        handler: async (input) => {
          console.log(`${input.toolName} wrote ${input.filePath}`);
        },
      },
      {
        event: "PermissionDenied",
        handler: async (input) => {
          console.log(`Denied ${input.toolName}: ${input.reason}`);
        },
      },
    ],
  },
});
```

| Category | Events |
|----------|--------|
| Session lifecycle | `SessionStart`, `SessionEnd`, `TurnStart`, `TurnEnd`, `Error` |
| Tool execution | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `FileWrite` |
| Permissions | `PermissionRequest`, `PermissionDenied` |
| Subagents | `SubagentStart`, `SubagentStop` |
| Compaction | `PreCompact`, `PostCompact` |
| System | `ModelSwitch`, `RetryAttempt`, `MemoryUpdate` |

See the [hooks documentation](https://noumen.dev/docs/hooks) for full details on each event.

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

const backend = new InProcessBackend(agent);
const swarm = new SwarmManager(backend, { maxConcurrent: 3 });

await swarm.spawn({ name: "researcher", prompt: "Find all TODOs" });
await swarm.spawn({ name: "writer", prompt: "Write tests for auth" });
await swarm.waitForAll();
```

## Memory

Persist knowledge across sessions:

```typescript
import { FileMemoryProvider } from "noumen";
import { LocalFs } from "noumen/local";

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
  mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    remote: { type: "http", url: "http://localhost:3001/mcp" },
  },
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
