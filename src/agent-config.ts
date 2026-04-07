import type { RetryConfig } from "./retry/types.js";
import { DEFAULT_RETRY_CONFIG } from "./retry/types.js";
import type { ProjectContextConfig } from "./context/types.js";

export interface ResolvedAgentConfig {
  effectiveCwd: string;
  retryConfig: RetryConfig | undefined;
  projectContextConfig: ProjectContextConfig | undefined;
  mcpServerConfigs: Record<string, unknown> | undefined;
  lspConfigs: Record<string, unknown> | undefined;
}

export interface AgentConfigInput {
  cwd?: string;
  optionsCwd?: string;
  retry?: RetryConfig | boolean;
  projectContext?: ProjectContextConfig | boolean;
  mcpServers?: Record<string, unknown>;
  lsp?: Record<string, unknown>;
}

export function resolveAgentConfig(input: AgentConfigInput): ResolvedAgentConfig {
  const effectiveCwd = input.cwd ?? input.optionsCwd ?? process.cwd();

  let retryConfig: RetryConfig | undefined;
  if (input.retry === true) {
    retryConfig = DEFAULT_RETRY_CONFIG;
  } else if (typeof input.retry === "object") {
    retryConfig = input.retry;
  }

  let projectContextConfig: ProjectContextConfig | undefined;
  if (input.projectContext === true) {
    projectContextConfig = { cwd: effectiveCwd };
  } else if (typeof input.projectContext === "object") {
    projectContextConfig = input.projectContext;
  }

  const mcpServerConfigs = input.mcpServers && Object.keys(input.mcpServers).length > 0
    ? input.mcpServers
    : undefined;

  const lspConfigs = input.lsp && Object.keys(input.lsp).length > 0
    ? input.lsp
    : undefined;

  return {
    effectiveCwd,
    retryConfig,
    projectContextConfig,
    mcpServerConfigs,
    lspConfigs,
  };
}
