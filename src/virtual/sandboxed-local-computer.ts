import { exec as execCb } from "node:child_process";
import type { VirtualComputer, ExecOptions, CommandResult } from "./computer.js";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

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

/**
 * `VirtualComputer` that wraps every command with OS-level sandboxing via
 * `@anthropic-ai/sandbox-runtime`. Uses macOS Seatbelt (`sandbox-exec`) or
 * Linux bubblewrap (`bwrap`) under the hood.
 */
export class SandboxedLocalComputer implements VirtualComputer {
  private defaultCwd: string;
  private defaultTimeout: number;
  private sandboxConfig: SandboxConfig;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(opts?: SandboxedLocalComputerOptions) {
    this.defaultCwd = opts?.defaultCwd ?? process.cwd();
    this.defaultTimeout = opts?.defaultTimeout ?? 30_000;
    this.sandboxConfig = opts?.sandbox ?? {};
  }

  private buildRuntimeConfig(): SandboxRuntimeConfig {
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

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          await SandboxManager.initialize(this.buildRuntimeConfig());
          this.initialized = true;
        } catch (err) {
          this.initPromise = null;
          throw err;
        }
      })();
    }

    await this.initPromise;
  }

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    await this.ensureInitialized();

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
          const result: CommandResult = {
            exitCode:
              error && "code" in error
                ? (error.code as number) ?? 1
                : child.exitCode ?? 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          };
          Promise.resolve(SandboxManager.cleanupAfterCommand())
            .then(() => resolve(result))
            .catch(() => resolve(result));
        },
      );
    });
  }

  /**
   * Tear down the sandbox runtime. Call when the agent is done.
   */
  async dispose(): Promise<void> {
    if (this.initialized) {
      await SandboxManager.reset();
      this.initialized = false;
      this.initPromise = null;
    }
  }
}
