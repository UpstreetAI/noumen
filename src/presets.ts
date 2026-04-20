import { Agent } from "./agent.js";
import type { AIProvider } from "./providers/types.js";
import type { Sandbox } from "./virtual/sandbox.js";
import type { HookDefinition } from "./hooks/types.js";
import type { McpServerConfig } from "./mcp/types.js";
import type { AutoTitleConfig } from "./session/auto-title.js";

export interface PresetOptions {
  /** The AI provider instance (e.g. `new AiSdkProvider({ model })`) */
  provider: AIProvider;
  /** Working directory for path resolution. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Model name override. Each preset has a sensible default. */
  model?: string;
  /**
   * Sandbox providing filesystem + shell execution. Required — the root
   * barrel deliberately doesn't pull in a default implementation, so
   * callers must pick a backend explicitly:
   *
   * - `import { UnsandboxedLocal } from "noumen/unsandboxed"` — raw host access.
   * - `import { LocalSandbox }     from "noumen/local"`       — OS-level sandboxing.
   * - `import { DockerSandbox }    from "noumen/docker"`
   * - `import { E2BSandbox }       from "noumen/e2b"`
   * - `import { FreestyleSandbox } from "noumen/freestyle"`
   * - `import { SshSandbox }       from "noumen/ssh"`
   * - `import { SpritesSandbox }   from "noumen/sprites"`
   *
   * You can also pass any `{ fs, computer }` pair for custom sandboxes.
   */
  sandbox: Sandbox;
  /** Extra hooks to attach. */
  hooks?: HookDefinition[];
  /** MCP servers to connect to during `init()`. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Custom system prompt prepended to the built-in prompt. */
  systemPrompt?: string;
  /**
   * Opt-in AI-generated session titles. `true` uses the agent's main
   * provider / model; pass a config object to override the model or
   * provider (typically a cheaper one like Haiku) used for title
   * generation only.
   */
  autoTitle?: AutoTitleConfig | boolean;
}

/**
 * Full-featured coding agent with subagents, tasks, plan mode, auto-compact,
 * retry, cost tracking, and project context enabled out of the box.
 */
export function codingAgent(opts: PresetOptions): Agent {
  const cwd = opts.cwd ?? process.cwd();
  return new Agent({
    provider: opts.provider,
    sandbox: opts.sandbox,
    options: {
      cwd,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      permissions: { mode: "default" },
      autoCompact: true,
      enableSubagents: true,
      enableTasks: true,
      enablePlanMode: true,
      projectContext: { cwd },
      costTracking: { enabled: true },
      retry: true,
      hooks: opts.hooks,
      mcpServers: opts.mcpServers,
      autoTitle: opts.autoTitle,
    },
  });
}

/**
 * Read-only planning agent — can explore the codebase but cannot make changes.
 * Useful for architecture analysis, code review prep, or scoping work.
 */
export function planningAgent(opts: PresetOptions): Agent {
  const cwd = opts.cwd ?? process.cwd();
  return new Agent({
    provider: opts.provider,
    sandbox: opts.sandbox,
    options: {
      cwd,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      permissions: { mode: "plan" },
      autoCompact: true,
      enableSubagents: false,
      enableTasks: false,
      enablePlanMode: true,
      projectContext: { cwd },
      costTracking: { enabled: true },
      retry: true,
      hooks: opts.hooks,
      mcpServers: opts.mcpServers,
      autoTitle: opts.autoTitle,
    },
  });
}

/**
 * Code review agent — read-only with web search enabled for looking up
 * documentation, best practices, and security advisories.
 */
export function reviewAgent(opts: PresetOptions): Agent {
  const cwd = opts.cwd ?? process.cwd();
  return new Agent({
    provider: opts.provider,
    sandbox: opts.sandbox,
    options: {
      cwd,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      permissions: { mode: "plan" },
      autoCompact: true,
      enableSubagents: false,
      enableTasks: false,
      enablePlanMode: true,
      projectContext: { cwd },
      costTracking: { enabled: true },
      retry: true,
      hooks: opts.hooks,
      mcpServers: opts.mcpServers,
      autoTitle: opts.autoTitle,
      webSearch: {
        search: async (query: string) => {
          try {
            const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
            if (!res.ok) return [];
            return [{ title: query, url: res.url, snippet: `Search results for: ${query}` }];
          } catch { return []; }
        },
      },
    },
  });
}
