import { exec as execCb } from "node:child_process";
import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";

/**
 * Filesystem and network restriction config passed to `@anthropic-ai/sandbox-runtime`.
 */
export interface SandboxConfig {
  filesystem?: {
    /** Paths the agent may write to (default: `[cwd]`). Write is denied everywhere else. */
    allowWrite?: string[];
    /** Paths to explicitly deny writes within allowed regions. */
    denyWrite?: string[];
    /** Paths to deny reading. By default everything is readable. */
    denyRead?: string[];
    /** Paths to re-allow reading within denyRead regions. Takes precedence over denyRead. */
    allowRead?: string[];
  };
  network?: {
    /** Domains the agent may reach via HTTP/HTTPS/SOCKS. */
    allowedDomains?: string[];
    /** Domains to explicitly block. */
    deniedDomains?: string[];
  };
}

export interface SandboxedLocalComputerOptions {
  defaultCwd?: string;
  defaultTimeout?: number;
  sandbox?: SandboxConfig;
}

type SandboxManagerModule = typeof import("@anthropic-ai/sandbox-runtime");

/**
 * `VirtualComputer` that wraps every command with OS-level sandboxing via
 * `@anthropic-ai/sandbox-runtime`. Uses macOS Seatbelt (`sandbox-exec`) or
 * Linux bubblewrap (`bwrap`) under the hood.
 *
 * Requires `@anthropic-ai/sandbox-runtime` as a peer dependency — it is
 * loaded lazily on first command execution.
 */
export class SandboxedLocalComputer implements VirtualComputer {
  private defaultCwd: string;
  private defaultTimeout: number;
  private sandboxConfig: SandboxConfig;
  private srtModule: SandboxManagerModule | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(opts?: SandboxedLocalComputerOptions) {
    this.defaultCwd = opts?.defaultCwd ?? process.cwd();
    this.defaultTimeout = opts?.defaultTimeout ?? 30_000;
    this.sandboxConfig = opts?.sandbox ?? {};
  }

  private buildRuntimeConfig(): Record<string, unknown> {
    const fs = this.sandboxConfig.filesystem;
    const net = this.sandboxConfig.network;
    return {
      filesystem: {
        allowWrite: fs?.allowWrite ?? [this.defaultCwd],
        denyWrite: fs?.denyWrite ?? [],
        denyRead: fs?.denyRead ?? [],
        allowRead: fs?.allowRead ?? [],
      },
      network: {
        allowedDomains: net?.allowedDomains ?? [],
        deniedDomains: net?.deniedDomains ?? [],
      },
    };
  }

  private async ensureInitialized(): Promise<SandboxManagerModule> {
    if (this.srtModule) return this.srtModule;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          this.srtModule = (await import(
            "@anthropic-ai/sandbox-runtime"
          )) as unknown as SandboxManagerModule;
        } catch {
          throw new Error(
            "LocalSandbox requires @anthropic-ai/sandbox-runtime for OS-level sandboxing. " +
              "Install it with: npm install @anthropic-ai/sandbox-runtime\n" +
              "Or use UnsandboxedLocal() if you don't need sandboxing.",
          );
        }

        const config = this.buildRuntimeConfig();
        await this.srtModule!.SandboxManager.initialize(config);
      })();
    }

    await this.initPromise;
    return this.srtModule!;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const { SandboxManager } = await this.ensureInitialized();

    const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

    return new Promise((resolve) => {
      const child = execCb(
        wrappedCommand,
        {
          cwd: opts?.cwd ?? this.defaultCwd,
          timeout: opts?.timeout ?? this.defaultTimeout,
          env: opts?.env ? { ...process.env, ...opts.env } : process.env,
          maxBuffer: 10 * 1024 * 1024,
          shell: process.env.SHELL || "/bin/sh",
        },
        (error, stdout, stderr) => {
          SandboxManager.cleanupAfterCommand();
          resolve({
            exitCode:
              error && "code" in error
                ? (error.code as number) ?? 1
                : child.exitCode ?? 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
    });
  }

  /**
   * Tear down the sandbox runtime. Call when the agent is done.
   */
  async dispose(): Promise<void> {
    if (this.srtModule) {
      await this.srtModule.SandboxManager.reset();
      this.srtModule = null;
      this.initPromise = null;
    }
  }
}
