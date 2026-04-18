import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServerConfig } from "../mcp/types.js";
import type { LspServerConfig } from "../lsp/types.js";
import type { HookDefinition } from "../hooks/types.js";
import type { WebSearchConfig } from "../tools/web-search.js";
import {
  DEFAULT_DOT_DIRS,
  createDotDirResolver,
  type DotDirConfig,
  type DotDirResolver,
} from "../config/dot-dirs.js";

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
  /**
   * Dot-directory configuration for the CLI. Controls which hidden
   * directories are read for config and written to on init.
   */
  dotDirs?: DotDirConfig;
}

/**
 * First-hit-wins read of `<base>/<dotdir>/<rel>` across the resolver's
 * candidate dirs. Returns parsed JSON or `null` if none found.
 */
function readFirstJson(resolver: DotDirResolver, base: string, rel: string): CliConfig | null {
  for (const candidate of resolver.joinRead(base, rel)) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      return JSON.parse(raw) as CliConfig;
    } catch {
      // keep walking
    }
  }
  return null;
}

/**
 * Bootstrap resolver for the initial config load. We read global config
 * first to discover any `dotDirs` override, then rebuild the resolver and
 * reload. This lets users put `{ "dotDirs": { "names": [".custom"] } }`
 * in a default location (`.noumen/config.json`) to reroute everything.
 */
function resolverFromConfigs(...configs: CliConfig[]): DotDirResolver {
  for (const cfg of configs) {
    if (cfg.dotDirs) return createDotDirResolver(cfg.dotDirs);
  }
  return createDotDirResolver(DEFAULT_DOT_DIRS);
}

/**
 * Load global config from the first hit across `~/<dotdir>/config.json`
 * candidates. Returns empty object if not found or invalid.
 */
export function loadGlobalConfig(resolver?: DotDirResolver): CliConfig {
  const r = resolver ?? createDotDirResolver(DEFAULT_DOT_DIRS);
  return readFirstJson(r, os.homedir(), "config.json") ?? {};
}

/**
 * Walk up from `cwd` looking for `<ancestor>/<dotdir>/config.json`. At
 * each ancestor, all candidate dot-dirs are probed in preference order
 * before moving up. Returns parsed config or empty object if none found.
 */
function loadProjectConfig(cwd: string, resolver?: DotDirResolver): CliConfig {
  const r = resolver ?? createDotDirResolver(DEFAULT_DOT_DIRS);
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;

  while (true) {
    const hit = readFirstJson(r, dir, "config.json");
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  return {};
}

/**
 * Load config with layering: global (home scope) < project < flags. If
 * either layer specifies a `dotDirs` override, that override is used for
 * any subsequent reads. Project-level values override global values.
 */
export function loadCliConfig(cwd: string): CliConfig {
  // Phase 1: probe with default resolver so we can discover dotDirs overrides.
  const bootstrapResolver = createDotDirResolver(DEFAULT_DOT_DIRS);
  const globalBootstrap = loadGlobalConfig(bootstrapResolver);
  const projectBootstrap = loadProjectConfig(cwd, bootstrapResolver);

  // Phase 2: if any layer declared dotDirs, rebuild the resolver and reload.
  const override = projectBootstrap.dotDirs ?? globalBootstrap.dotDirs;
  if (override) {
    const resolver = createDotDirResolver(override);
    const global = loadGlobalConfig(resolver);
    const project = loadProjectConfig(cwd, resolver);
    return { ...global, ...project };
  }

  return { ...globalBootstrap, ...projectBootstrap };
}

/**
 * Resolve the CLI dot-dir resolver after layering. Used by code paths
 * that need to write (e.g. init) or locate auxiliary dirs.
 */
export function resolveCliDotDirs(config: CliConfig): DotDirResolver {
  return resolverFromConfigs(config);
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
