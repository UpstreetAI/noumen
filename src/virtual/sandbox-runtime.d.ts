declare module "@anthropic-ai/sandbox-runtime" {
  export interface SandboxRuntimeConfig {
    filesystem?: {
      allowWrite?: string[];
      denyWrite?: string[];
      denyRead?: string[];
      allowRead?: string[];
    };
    network?: {
      allowedDomains?: string[];
      deniedDomains?: string[];
    };
    [key: string]: unknown;
  }

  export const SandboxManager: {
    initialize(config: SandboxRuntimeConfig): Promise<void>;
    wrapWithSandbox(
      command: string,
      binShell?: string,
      customConfig?: Partial<SandboxRuntimeConfig>,
      abortSignal?: AbortSignal,
    ): Promise<string>;
    reset(): Promise<void>;
    isSandboxingEnabled(): boolean;
    isSupportedPlatform(): boolean;
    checkDependencies(ripgrep?: unknown): {
      satisfied: boolean;
      missing?: string[];
    };
    cleanupAfterCommand(): void;
  };
}
