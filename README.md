# lisk-code

Programmatic AI coding agent library with pluggable providers and virtual infrastructure.

`lisk-code` gives you a headless, API-only coding agent that can read, write, edit files, run shell commands, and search codebases — all backed by swappable AI providers (OpenAI, Anthropic) and virtual filesystems/computers (local Node.js, [sprites.dev](https://sprites.dev) containers).

## Install

```bash
pnpm add lisk-code
```

## Quick Start

```typescript
import {
  Code,
  OpenAIProvider,
  LocalFs,
  LocalComputer,
} from "lisk-code";

const code = new Code({
  aiProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  virtualFs: new LocalFs({ basePath: "/my/project" }),
  virtualComputer: new LocalComputer({ defaultCwd: "/my/project" }),
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
import { OpenAIProvider } from "lisk-code";

const provider = new OpenAIProvider({
  apiKey: "sk-...",
  model: "gpt-4o",      // default
  baseURL: "https://...", // optional, for compatible APIs
});
```

### Anthropic

```typescript
import { AnthropicProvider } from "lisk-code";

const provider = new AnthropicProvider({
  apiKey: "sk-ant-...",
  model: "claude-sonnet-4-20250514", // default
});
```

## Virtual Infrastructure

### Local (Node.js)

Backed by `fs/promises` and `child_process`:

```typescript
import { LocalFs, LocalComputer } from "lisk-code";

const fs = new LocalFs({ basePath: "/my/project" });
const computer = new LocalComputer({ defaultCwd: "/my/project" });
```

### sprites.dev

Run inside a remote [sprites.dev](https://docs.sprites.dev) container:

```typescript
import { SpritesFs, SpritesComputer } from "lisk-code";

const fs = new SpritesFs({
  token: process.env.SPRITE_TOKEN,
  spriteName: "my-sprite",
});

const computer = new SpritesComputer({
  token: process.env.SPRITE_TOKEN,
  spriteName: "my-sprite",
});
```

## Options

```typescript
const code = new Code({
  aiProvider,
  virtualFs,
  virtualComputer,
  options: {
    sessionDir: ".lisk-code/sessions", // JSONL transcript storage path
    model: "gpt-4o",                   // default model
    maxTokens: 8192,                   // max output tokens per turn
    autoCompact: true,                 // auto-compact when context is large
    autoCompactThreshold: 100_000,     // token threshold for auto-compact
    systemPrompt: "...",               // override the built-in system prompt
    cwd: "/working/dir",              // working directory for tools
    skills: [{ name: "...", content: "..." }],
    skillsPaths: [".claude/skills"],   // paths to SKILL.md files on virtualFs
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
| `tool_use_start` | `toolName`, `toolUseId` | Model is calling a tool |
| `tool_use_delta` | `input` | Incremental tool call arguments |
| `tool_result` | `toolUseId`, `toolName`, `result` | Tool execution result |
| `message_complete` | `message` | Full assistant message |
| `compact_start` | | Auto-compaction started |
| `compact_complete` | | Auto-compaction finished |
| `error` | `error` | An error occurred |

## Built-in Tools

| Tool | Description |
|------|-------------|
| **ReadFile** | Read files with line numbers, offset/limit support |
| **WriteFile** | Create or overwrite files |
| **EditFile** | Find-and-replace string editing |
| **Bash** | Execute shell commands |
| **Glob** | Find files by glob pattern (via ripgrep) |
| **Grep** | Search file contents by regex (via ripgrep) |

## Skills

Skills are markdown instructions injected into the system prompt. Provide them inline or load from `SKILL.md` files on the virtual filesystem:

```typescript
const code = new Code({
  aiProvider,
  virtualFs,
  virtualComputer,
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

## Sessions

Conversations are persisted as JSONL files on the virtual filesystem. Each line is a serialized message entry. Compaction writes a boundary marker followed by a summary, so resumed sessions only load post-boundary messages.

```typescript
// List all saved sessions
const sessions = await code.listSessions();
// [{ sessionId, createdAt, lastMessageAt, title?, messageCount }]
```

## License

MIT
