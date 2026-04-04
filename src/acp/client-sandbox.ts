/**
 * AcpClientSandbox: VirtualFs + VirtualComputer backed by the ACP client.
 *
 * In the ACP model, the **client** (editor/IDE) provides filesystem and
 * terminal access. This sandbox implementation sends JSON-RPC requests to
 * the client for every fs/shell operation. It's a natural fit for noumen's
 * pluggable sandbox architecture.
 */

import type { VirtualFs, FileEntry, FileStat, ReadOptions } from "../virtual/fs.js";
import type { VirtualComputer, ExecOptions, CommandResult } from "../virtual/computer.js";
import type { Sandbox } from "../virtual/sandbox.js";
import type { AcpTransport } from "./types.js";
import { ACP_METHODS } from "./types.js";
import {
  formatRequest,
  type JsonRpcResponse,
} from "../jsonrpc/index.js";

let _nextId = 1;

export class AcpClientSandbox {
  readonly fs: AcpClientFs;
  readonly computer: AcpClientComputer;

  constructor(
    private transport: AcpTransport,
    private sendRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    this.fs = new AcpClientFs(sendRequest);
    this.computer = new AcpClientComputer(sendRequest);
  }
}

class AcpClientFs implements VirtualFs {
  constructor(
    private sendRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {}

  async readFile(path: string, _opts?: ReadOptions): Promise<string> {
    const result = (await this.sendRequest(ACP_METHODS.FS_READ, { path })) as {
      content: string;
    };
    return result.content;
  }

  async readFileBytes(path: string, maxBytes?: number): Promise<Buffer> {
    const result = (await this.sendRequest(ACP_METHODS.FS_READ_BYTES, {
      path,
      maxBytes,
    })) as { data: string };
    return Buffer.from(result.data, "base64");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sendRequest(ACP_METHODS.FS_WRITE, { path, content });
  }

  async appendFile(path: string, content: string): Promise<void> {
    let existing = "";
    try {
      existing = await this.readFile(path);
    } catch {
      // file may not exist
    }
    await this.writeFile(path, existing + content);
  }

  async deleteFile(
    path: string,
    opts?: { recursive?: boolean },
  ): Promise<void> {
    await this.sendRequest(ACP_METHODS.FS_DELETE, {
      path,
      recursive: opts?.recursive ?? false,
    });
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.sendRequest(ACP_METHODS.FS_MKDIR, {
      path,
      recursive: opts?.recursive ?? false,
    });
  }

  async readdir(
    path: string,
    _opts?: { recursive?: boolean },
  ): Promise<FileEntry[]> {
    const result = (await this.sendRequest(ACP_METHODS.FS_READDIR, {
      path,
    })) as FileEntry[];
    return result;
  }

  async exists(path: string): Promise<boolean> {
    const result = (await this.sendRequest(ACP_METHODS.FS_EXISTS, {
      path,
    })) as boolean;
    return result;
  }

  async stat(path: string): Promise<FileStat> {
    const result = (await this.sendRequest(ACP_METHODS.FS_STAT, {
      path,
    })) as {
      size: number;
      isDirectory: boolean;
      isFile: boolean;
      modifiedAt?: string;
    };
    return {
      size: result.size,
      isDirectory: result.isDirectory,
      isFile: result.isFile,
      modifiedAt: result.modifiedAt ? new Date(result.modifiedAt) : undefined,
    };
  }
}

class AcpClientComputer implements VirtualComputer {
  constructor(
    private sendRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {}

  async executeCommand(
    command: string,
    opts?: ExecOptions,
  ): Promise<CommandResult> {
    const result = (await this.sendRequest(ACP_METHODS.TERMINAL_EXEC, {
      command,
      cwd: opts?.cwd,
      timeout: opts?.timeout,
    })) as { exitCode: number; stdout: string; stderr: string };
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}
