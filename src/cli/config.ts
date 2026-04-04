import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServerConfig } from "../mcp/types.js";
import type { LspServerConfig } from "../lsp/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { WebSearchConfig } from "../tools/web-search.js";

export interface CliConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  permissions?: string;
  thinking?: string;
  sandbox?: string;
  mcpServers?: Record<string, McpServerConfig>;
  lsp?: Record<string, LspServerConfig>;
  hooks?: HookDefinition[];
  autoCompact?: boolean;
  enableSubagents?: boolean;
  enableTasks?: boolean;
  enablePlanMode?: boolean;
  enableWorktrees?: boolean;
  webSearch?: WebSearchConfig;
  costLimit?: number;
  maxTurns?: number;
  systemPrompt?: string;
  sessionDir?: string;
}

/**
 * Load global config from ~/.noumen/config.json.
 * Returns empty object if not found or invalid.
 */
export function loadGlobalConfig(): CliConfig {
  const globalPath = path.join(os.homedir(), ".noumen", "config.json");
  try {
    const raw = fs.readFileSync(globalPath, "utf-8");
    return JSON.parse(raw) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Walk up from `cwd` looking for `.noumen/config.json`.
 * Returns parsed config or empty object if none found.
 */
function loadProjectConfig(cwd: string): CliConfig {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, ".noumen", "config.json");
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      return JSON.parse(raw) as CliConfig;
    } catch {
      // not found or invalid — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  return {};
}

/**
 * Load config with layering: global (~/.noumen/config.json) < project < flags.
 * Project-level values override global values.
 */
export function loadCliConfig(cwd: string): CliConfig {
  const global = loadGlobalConfig();
  const project = loadProjectConfig(cwd);
  return { ...global, ...project };
}

export interface MergedConfig extends CliConfig {
  cwd: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  headless?: boolean;
  prompt?: string;
  noSandbox?: boolean;
  sandboxAllowWrite?: string;
  sandboxAllowDomain?: string;
}

/**
 * Merge CLI flags over the config file values. Flags take precedence.
 */
export function mergeConfig(
  config: CliConfig,
  flags: Record<string, unknown>,
): MergedConfig {
  const cwd = (flags.cwd as string) ?? process.cwd();
  return {
    ...config,
    ...(flags.provider !== undefined && { provider: flags.provider as string }),
    ...(flags.model !== undefined && { model: flags.model as string }),
    ...(flags.apiKey !== undefined && { apiKey: flags.apiKey as string }),
    ...(flags.baseUrl !== undefined && { baseURL: flags.baseUrl as string }),
    ...(flags.permission !== undefined && { permissions: flags.permission as string }),
    ...(flags.thinking !== undefined && { thinking: flags.thinking as string }),
    ...(flags.maxTurns !== undefined && { maxTurns: flags.maxTurns as number }),
    ...(flags.systemPrompt !== undefined && { systemPrompt: flags.systemPrompt as string }),
    cwd,
    json: flags.json as boolean | undefined,
    quiet: flags.quiet as boolean | undefined,
    verbose: flags.verbose as boolean | undefined,
    headless: flags.headless as boolean | undefined,
    prompt: flags.prompt as string | undefined,
    noSandbox: flags.sandbox === false ? true : undefined,
    sandboxAllowWrite: flags.sandboxAllowWrite as string | undefined,
    sandboxAllowDomain: flags.sandboxAllowDomain as string | undefined,
  };
}
