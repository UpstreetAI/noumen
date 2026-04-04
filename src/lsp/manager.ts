import { LspClient } from "./client.js";
import { DiagnosticRegistry } from "./diagnostics.js";
import type { LspServerConfig, LspDiagnostic } from "./types.js";

interface ManagedServer {
  config: LspServerConfig;
  client: LspClient;
  openFiles: Set<string>;
}

/**
 * Manages multiple LSP servers, maps file extensions to servers,
 * and handles lifecycle (lazy start, file sync, shutdown).
 */
export class LspServerManager {
  private servers = new Map<string, ManagedServer>();
  private extensionMap = new Map<string, string>();
  private diagnostics = new DiagnosticRegistry();
  private rootUri: string;

  constructor(
    configs: Record<string, LspServerConfig>,
    rootUri: string,
  ) {
    this.rootUri = rootUri.startsWith("file://") ? rootUri : `file://${rootUri}`;

    for (const [name, config] of Object.entries(configs)) {
      const client = new LspClient(config);
      client.onDiagnostics((diags) => this.diagnostics.register(diags));
      this.servers.set(name, {
        config,
        client,
        openFiles: new Set(),
      });

      for (const ext of config.fileExtensions) {
        this.extensionMap.set(ext, name);
      }
    }
  }

  /**
   * Get the server that handles a given file path.
   */
  private getServerForFile(filePath: string): ManagedServer | undefined {
    const ext = filePath.includes(".")
      ? "." + filePath.split(".").pop()!
      : "";
    const serverName = this.extensionMap.get(ext);
    if (!serverName) return undefined;
    return this.servers.get(serverName);
  }

  /**
   * Ensure a server is started, starting it lazily if needed.
   */
  private async ensureStarted(server: ManagedServer): Promise<void> {
    if (server.client.state === "running") return;
    await server.client.start(this.rootUri);
  }

  /**
   * Send a request to the appropriate server for a file.
   */
  async sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | null> {
    const server = this.getServerForFile(filePath);
    if (!server) return null;

    await this.ensureStarted(server);
    await this.ensureFileOpen(server, filePath);

    return server.client.sendRequest<T>(method, params);
  }

  /**
   * Notify LSP servers that a file was opened or changed.
   */
  async notifyFileChanged(
    filePath: string,
    content: string,
    version: number,
  ): Promise<void> {
    const server = this.getServerForFile(filePath);
    if (!server) return;
    if (server.client.state !== "running") return;

    const uri = `file://${filePath}`;
    if (server.openFiles.has(filePath)) {
      server.client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    } else {
      await this.ensureFileOpen(server, filePath, content);
    }
  }

  /**
   * Notify LSP servers that a file was saved.
   */
  notifyFileSaved(filePath: string): void {
    const server = this.getServerForFile(filePath);
    if (!server || server.client.state !== "running") return;

    server.client.sendNotification("textDocument/didSave", {
      textDocument: { uri: `file://${filePath}` },
    });
  }

  private async ensureFileOpen(
    server: ManagedServer,
    filePath: string,
    content?: string,
  ): Promise<void> {
    if (server.openFiles.has(filePath)) return;

    const uri = `file://${filePath}`;
    const ext = filePath.includes(".")
      ? filePath.split(".").pop()!
      : "plaintext";

    server.client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: mapExtToLanguageId(ext),
        version: 1,
        text: content ?? "",
      },
    });
    server.openFiles.add(filePath);
  }

  /**
   * Get the diagnostic registry for reading pending diagnostics.
   */
  getDiagnostics(): DiagnosticRegistry {
    return this.diagnostics;
  }

  /**
   * Check if any LSP server is connected and running.
   */
  isConnected(): boolean {
    for (const server of this.servers.values()) {
      if (server.client.state === "running") return true;
    }
    return false;
  }

  /**
   * Shut down all LSP servers.
   */
  async shutdown(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const server of this.servers.values()) {
      tasks.push(server.client.stop());
    }
    await Promise.all(tasks);
  }
}

function mapExtToLanguageId(ext: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    rb: "ruby",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    html: "html",
    css: "css",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "shellscript",
    bash: "shellscript",
  };
  return map[ext] ?? "plaintext";
}
